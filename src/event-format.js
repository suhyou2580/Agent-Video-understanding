/**
 * 紧凑事件格式（省 token 的对外 schema）与内部结构之间的双向转换。
 *
 * 为什么要有这一层：视觉模型每输出一条事件都要付费，而"JSON 键名 + 完整 frame_id"
 * 能把一条事件从 25 token 顶到 70 token。实测（112x124 动图、8 帧）：
 *
 *   {"t":[1480,2000],"e":"猫支起上身抬头"}                     25 token
 *   + "k":"mv"                                                  33
 *   + "m":1                                                     39
 *   + "a":"cat"                                                 47   ← 仍在 50 内
 *   + "c":0.8                                                   55   ← 超了
 *   + "w":1                                                     61
 *   + 完整 evidence_frame_ids                                   70
 *
 * 所以规则是：
 *  1. 必填只有 `t`（时间范围）与 `e`（描述**变化**，不是描述每个画面）；
 *  2. `k/m/a/c/w` 都是**按需出现**——不写就不占 token；
 *  3. **证据帧不要求模型输出**：服务端按时间范围从已知帧时间轴派生（省 24 token/条），
 *     仍然保证"每个事件可追溯到帧"；
 *  4. 想标"推断"时才加 `x:1`（默认按观察），避免为每条事件都付观察/推断的标记钱。
 *
 * 字段表：
 *   t  必填  [startMs] 或 [startMs, endMs]
 *   e  必填  描述"发生了什么变化"，建议 ≤ 20 字
 *   k  可选  数据类型：mv 动作 / st 状态 / ap 出现 / ds 消失 / tr 转变 / sc 场景切换
 *   m  可选  动作连续性：0 单次 / 1 连续 / 2 重复
 *   a  可选  角色/主体（≤16 字，单主体时建议省略）
 *   c  可选  模型置信度 0~1（拿不准才写；没有可靠把握就别编）
 *   w  可选  1 = 值得写入长期记忆
 *   x  可选  1 = 推断（默认按观察）
 *   f  可选  显式证据帧（一般不要写，服务端会派生）
 */

export const EVENT_KINDS = Object.freeze({
  mv: 'motion',       // 动作/移动
  st: 'state',        // 状态（保持某种姿态）
  ap: 'appear',       // 出现
  ds: 'disappear',    // 消失
  tr: 'transform',    // 外观转变
  sc: 'scene_change', // 场景切换
});

export const CONTINUITY = Object.freeze({
  0: 'once',
  1: 'continuous',
  2: 'repeated',
});

/** 每条事件的 token 预算（超过就提示模型精简，不阻断）。 */
export const EVENT_TOKEN_TARGET = 50;
/** 单次提交整条时间线的 token 预算（超过就拒收，逼模型压缩条数）。 */
export const TIMELINE_TOKEN_TARGET = 400;

const MAX_DESCRIPTION = 120;
const MAX_ACTOR = 16;

function isInt(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

/** 极简 token 估算：只用于"给模型回显成本"，与渲染侧的估算口径一致。 */
export function estimateEventTokens(event) {
  const json = JSON.stringify(event);
  let total = 0;
  let word = 0;
  const flush = () => {
    if (word > 0) total += Math.ceil(word / 4);
    word = 0;
  };
  for (const ch of json) {
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)) {
      flush();
      total += 1;
    } else if (/[A-Za-z0-9_]/.test(ch)) {
      word += 1;
    } else {
      flush();
      total += 1;
    }
  }
  flush();
  return total;
}

/** 判断输入是紧凑格式还是旧的全字段格式。 */
export function isCompactEvent(raw) {
  return raw && typeof raw === 'object' && ('t' in raw || 'e' in raw || 'k' in raw);
}

/**
 * 把紧凑事件规范化。
 * @param {object} raw
 * @param {{ durationMs?: number|null }} context
 * @returns {{ ok: boolean, compact: object|null, errors: string[], warnings: string[] }}
 */
export function normalizeCompactEvent(raw, context = {}) {
  const errors = [];
  const warnings = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, compact: null, errors: ['事件必须是对象'], warnings };
  }

  // ── t：时间范围 ──
  const t = raw.t;
  let startMs = null;
  let endMs = null;
  if (!Array.isArray(t) || t.length === 0 || t.length > 2) {
    errors.push('t 必须是 [起始毫秒] 或 [起始毫秒, 结束毫秒]');
  } else if (!isInt(t[0]) || t[0] < 0) {
    errors.push('t[0] 必须是 >= 0 的整数毫秒');
  } else {
    startMs = t[0];
    if (t.length === 2) {
      if (!isInt(t[1]) || t[1] < startMs) errors.push('t[1] 必须是 >= t[0] 的整数毫秒');
      else endMs = t[1];
    }
  }

  const durationMs = context.durationMs ?? null;
  const tolerance = 1000;
  if (durationMs !== null && isInt(startMs) && startMs > durationMs + tolerance) {
    errors.push(`t 超出媒体时长 ${durationMs}ms`);
  }
  if (durationMs !== null && isInt(endMs) && endMs > durationMs + tolerance) {
    errors.push(`t[1] 超出媒体时长 ${durationMs}ms`);
  }

  // ── e：描述"变化" ──
  const description = typeof raw.e === 'string' ? raw.e.trim() : '';
  if (description.length === 0) errors.push('e 不能为空（写"发生了什么变化"，不是描述每个画面）');
  if (description.length > MAX_DESCRIPTION) errors.push(`e 超过 ${MAX_DESCRIPTION} 字符`);

  // ── k：数据类型 ──
  let kind = null;
  if (raw.k !== undefined && raw.k !== null && raw.k !== '') {
    const key = String(raw.k).trim().toLowerCase();
    if (!(key in EVENT_KINDS)) {
      errors.push(`k 必须是 ${Object.keys(EVENT_KINDS).join('/')} 之一`);
    } else {
      kind = key;
    }
  }

  // ── m：连续性 ──
  let continuity = null;
  if (raw.m !== undefined && raw.m !== null && raw.m !== '') {
    const key = String(raw.m).trim();
    if (!(key in CONTINUITY)) errors.push('m 必须是 0（单次）/1（连续）/2（重复）');
    else continuity = CONTINUITY[key];
  }

  // ── a：角色/主体 ──
  let actor = null;
  if (raw.a !== undefined && raw.a !== null && raw.a !== '') {
    const value = String(raw.a).trim();
    if (value.length > MAX_ACTOR) errors.push(`a 超过 ${MAX_ACTOR} 字符`);
    else actor = value;
  }

  // ── c：置信度（可选，拿不准才写）──
  let confidence = null;
  if (raw.c !== undefined && raw.c !== null && raw.c !== '') {
    const value = Number(raw.c);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      warnings.push('c 不在 0~1，已忽略（不编造分数）');
    } else {
      confidence = Number(value.toFixed(2));
    }
  }

  // ── x：观察还是推断（默认观察）──
  const isInference = raw.x === 1 || raw.x === true || raw.x === '1';
  if (raw.x !== undefined && raw.x !== null && ![0, 1, true, false, '0', '1'].includes(raw.x)) {
    warnings.push('x 只接受 0/1，已按观察处理');
  }

  // ── f：显式证据帧（一般不需要，服务端派生）──
  const explicitFrames = Array.isArray(raw.f) ? raw.f.map(String) : null;
  if (explicitFrames) {
    warnings.push('f 已提供显式证据帧；一般不必写，服务端会按时间范围自动派生');
  }

  // ── w：是否值得写入长期记忆 ──
  const worthMemory = raw.w === 1 || raw.w === true || raw.w === '1';

  if (errors.length > 0) return { ok: false, compact: null, errors, warnings };

  const compact = { t: endMs === null ? [startMs] : [startMs, endMs] };
  compact.e = description;
  if (kind) compact.k = kind;
  if (continuity) compact.m = continuity;
  if (actor) compact.a = actor;
  if (confidence !== null) compact.c = confidence;
  if (isInference) compact.x = 1;
  if (worthMemory) compact.w = 1;

  return {
    ok: true,
    compact,
    errors,
    warnings,
    // 内部字段（不参与 token 计量）
    internal: {
      start_ms: startMs,
      end_ms: endMs,
      description,
      kind,
      continuity,
      actor,
      confidence,
      observation_or_inference: isInference ? 'inference' : 'observation',
      worth_memory: worthMemory ? 1 : 0,
      explicit_frame_ids: explicitFrames,
    },
  };
}

/**
 * 按时间范围从已知帧时间轴派生证据帧。
 * 规则：取时间窗内所有帧；窗口为空时取最近的一帧（宁可给最近证据，也不给空证据）。
 * @param {Array<{frame_id:string, timestamp_ms:number}>} frames
 * @param {number} startMs
 * @param {number|null} endMs
 * @returns {string[]}
 */
export function deriveEvidenceFrames(frames, startMs, endMs) {
  if (!Array.isArray(frames) || frames.length === 0) return [];
  const from = startMs;
  const to = endMs === null || endMs === undefined ? startMs : endMs;
  const inside = frames
    .filter((frame) => frame.timestamp_ms >= from && frame.timestamp_ms <= Math.max(from, to))
    .map((frame) => frame.frame_id);
  if (inside.length > 0) return inside.slice(0, 6);
  // 窗口内没有帧：取离 startMs 最近的那一帧
  let best = frames[0];
  for (const frame of frames) {
    if (Math.abs(frame.timestamp_ms - startMs) < Math.abs(best.timestamp_ms - startMs)) best = frame;
  }
  return [best.frame_id];
}

/**
 * 校验整条时间线（紧凑格式），并给出 token 预算反馈。
 * @param {object[]} list
 * @param {{ durationMs?: number|null }} context
 */
export function normalizeTimeline(list, context = {}) {
  if (!Array.isArray(list)) {
    return { ok: false, events: [], errors: ['events 必须是数组'], warnings: [], tokens: 0 };
  }
  if (list.length === 0) {
    return { ok: false, events: [], errors: ['events 不能为空'], warnings: [], tokens: 0 };
  }
  if (list.length > 60) {
    return { ok: false, events: [], errors: ['单次最多提交 60 个事件'], warnings: [], tokens: 0 };
  }
  const events = [];
  const errors = [];
  const warnings = [];
  let tokens = 0;
  for (const [index, raw] of list.entries()) {
    const result = normalizeCompactEvent(raw, context);
    warnings.push(...result.warnings.map((w) => `#${index}: ${w}`));
    if (!result.ok) {
      errors.push(`#${index}: ${result.errors.join('；')}`);
      continue;
    }
    const cost = estimateEventTokens(result.compact);
    if (cost > EVENT_TOKEN_TARGET) {
      warnings.push(`#${index} 用了 ${cost} token（目标 ≤${EVENT_TOKEN_TARGET}）：可缩短 e、去掉 a 或 c`);
    }
    tokens += cost;
    events.push({ ...result.internal, tokens: cost, compact: result.compact });
  }
  if (errors.length > 0) return { ok: false, events: [], errors, warnings, tokens };
  if (tokens > TIMELINE_TOKEN_TARGET) {
    return {
      ok: false,
      events: [],
      errors: [`整条时间线 ${tokens} token，超过预算 ${TIMELINE_TOKEN_TARGET}；请合并相近事件或缩短描述`],
      warnings,
      tokens,
    };
  }
  events.sort((a, b) => a.start_ms - b.start_ms);
  return { ok: true, events, errors: [], warnings, tokens };
}

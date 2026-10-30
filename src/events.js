/**
 * 事件结构校验。
 *
 * 这一层是"不许把推断写成事实"的闸门：
 *  - 强制 `observation_or_inference` 与 `uncertainty`；
 *  - 强制时间范围落在媒体真实时长内；
 *  - 强制**可追溯**：至少给一个证据帧或一条转录引用，否则拒收；
 *  - `confidence` 只在真的给了 0~1 数值时才保留，否则写 null（不编分数）。
 */

export const OBSERVATION_KINDS = Object.freeze(['observation', 'inference']);
export const UNCERTAINTY_LEVELS = Object.freeze(['low', 'medium', 'high']);

const MAX_DESCRIPTION = 500;

function isInt(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * 校验单个事件。
 * @param {object} raw
 * @param {{ durationMs?: number|null, frameIds?: Set<string>|null }} context
 * @returns {{ ok: boolean, event: object|null, errors: string[], warnings: string[] }}
 */
export function validateEvent(raw, context = {}) {
  const errors = [];
  const warnings = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, event: null, errors: ['事件必须是对象'], warnings };
  }

  // ── 时间范围 ──
  const startMs = raw.start_ms;
  if (!isInt(startMs) || startMs < 0) {
    errors.push('start_ms 必须是 >= 0 的整数毫秒');
  }
  let endMs = raw.end_ms ?? null;
  if (endMs !== null) {
    if (!isInt(endMs) || endMs < 0) errors.push('end_ms 必须是 >= 0 的整数毫秒或 null');
    else if (isInt(startMs) && endMs < startMs) errors.push('end_ms 不能早于 start_ms');
  }
  const durationMs = context.durationMs ?? null;
  const tolerance = 1000;
  if (durationMs !== null && isInt(startMs) && startMs > durationMs + tolerance) {
    errors.push(`start_ms=${startMs} 超出媒体时长 ${durationMs}ms`);
  }
  if (durationMs !== null && isInt(endMs) && endMs > durationMs + tolerance) {
    errors.push(`end_ms=${endMs} 超出媒体时长 ${durationMs}ms`);
  }

  // ── 描述 ──
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (description.length === 0) errors.push('description 不能为空');
  if (description.length > MAX_DESCRIPTION) errors.push(`description 超过 ${MAX_DESCRIPTION} 字符`);

  // ── 证据可追溯性 ──
  const evidence = Array.isArray(raw.evidence_frame_ids) ? raw.evidence_frame_ids.map(String) : [];
  const transcriptRefs = Array.isArray(raw.transcript_refs) ? raw.transcript_refs.map(String) : [];
  if (evidence.length === 0 && transcriptRefs.length === 0) {
    errors.push('必须给出 evidence_frame_ids 或 transcript_refs（事件必须可追溯，不允许凭空描述）');
  }
  const knownFrames = context.frameIds instanceof Set ? context.frameIds : null;
  if (knownFrames && evidence.length > 0) {
    const unknown = evidence.filter((id) => !knownFrames.has(id));
    if (unknown.length === evidence.length) {
      errors.push(`evidence_frame_ids 全部不在本任务的帧里：${unknown.slice(0, 3).join(',')}`);
    } else if (unknown.length > 0) {
      warnings.push(`有 ${unknown.length} 个证据帧 id 不属于本任务，已丢弃：${unknown.slice(0, 3).join(',')}`);
    }
  }
  const keptEvidence = knownFrames ? evidence.filter((id) => knownFrames.has(id)) : evidence;

  // ── 观察还是推断 ──
  const kind = String(raw.observation_or_inference ?? '').trim().toLowerCase();
  if (!OBSERVATION_KINDS.includes(kind)) {
    errors.push(`observation_or_inference 必须是 ${OBSERVATION_KINDS.join(' 或 ')}`);
  }

  // ── 不确定性 ──
  let uncertainty = String(raw.uncertainty ?? '').trim().toLowerCase();
  if (uncertainty.length === 0) {
    uncertainty = 'high';
    warnings.push('未提供 uncertainty，按 high（保守）处理');
  } else if (!UNCERTAINTY_LEVELS.includes(uncertainty)) {
    errors.push(`uncertainty 必须是 ${UNCERTAINTY_LEVELS.join('/')}`);
  }

  // ── 置信度：没有可靠来源就写 null ──
  let confidence = null;
  if (raw.confidence !== null && raw.confidence !== undefined) {
    const value = Number(raw.confidence);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      warnings.push('confidence 不在 0~1，已置为 null（不编造分数）');
    } else {
      confidence = Number(value.toFixed(4));
    }
  }

  if (errors.length > 0) return { ok: false, event: null, errors, warnings };

  return {
    ok: true,
    event: {
      start_ms: startMs,
      end_ms: endMs,
      description,
      evidence_frame_ids: keptEvidence,
      transcript_refs: transcriptRefs,
      observation_or_inference: kind,
      uncertainty,
      confidence,
    },
    errors,
    warnings,
  };
}

/**
 * 校验一批事件，并按开始时间排序。
 * @returns {{ ok: boolean, events: object[], errors: Array<{index:number, messages:string[]}>, warnings: string[] }}
 */
export function validateEvents(list, context = {}) {
  const warnings = [];
  if (!Array.isArray(list)) {
    return { ok: false, events: [], errors: [{ index: -1, messages: ['events 必须是数组'] }], warnings };
  }
  if (list.length === 0) {
    return { ok: false, events: [], errors: [{ index: -1, messages: ['events 不能为空'] }], warnings };
  }
  if (list.length > 200) {
    return { ok: false, events: [], errors: [{ index: -1, messages: ['单次最多提交 200 个事件'] }], warnings };
  }
  const events = [];
  const errors = [];
  for (const [index, raw] of list.entries()) {
    const result = validateEvent(raw, context);
    warnings.push(...result.warnings.map((w) => `#${index}: ${w}`));
    if (!result.ok) {
      errors.push({ index, messages: result.errors });
      continue;
    }
    events.push(result.event);
  }
  if (errors.length > 0) return { ok: false, events: [], errors, warnings };
  events.sort((a, b) => a.start_ms - b.start_ms);
  return { ok: true, events, errors: [], warnings };
}

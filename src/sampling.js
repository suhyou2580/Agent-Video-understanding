/**
 * 采样计划：决定"看哪几帧"，并给出**覆盖范围与盲区**的说明。
 *
 * 这是"不只看第一帧""不能声称看完全片"的实现落点：
 *  - 概览模式：按时间均匀取点 + 首尾帧 + 场景切换候选帧；
 *  - 局部精读：围绕用户指定时间段加密；
 *  - GIF/动画：按**时间轴**取点，不按帧序号（帧延迟不均匀时序号会骗人）。
 *
 * 成本闸门：图片 token 预算不够时**减帧**，而不是硬发一堆图。
 */

import { resolveTools, run, summarizeFailure, localProtocolArgs, remoteProtocolArgs } from './media.js';

// DeepSeek 视觉 token 计费口径（从 dsh-llm-deepseek 适配器源码读出）：
// PATCH_SIZE=14、DOWNSAMPLE_RATIO=3、MAX_IMAGE_TOKENS=1024、MIN_PIXELS=544*544
// tokens = gridHeight * (gridWidth + 1) + 2
const PATCH_SIZE = 14;
const DOWNSAMPLE_RATIO = 3;
const MAX_IMAGE_TOKENS = 1024;
const MIN_PIXELS = 544 * 544;

const ceilDiv = (value, divisor) => Math.floor((value + divisor - 1) / divisor);

/**
 * 估算单张图片的 token。这是**估算**：真实数值以服务端计费为准，
 * 但公式与适配器一致，用于预算控制足够。
 * @param {number} width
 * @param {number} height
 */
export function estimateImageTokens(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;
  let w = Math.round(width);
  let h = Math.round(height);
  const pixels = w * h;
  if (pixels < MIN_PIXELS) {
    const scale = Math.sqrt(MIN_PIXELS / pixels);
    w = Math.trunc(w * scale);
    h = Math.trunc(h * scale);
  }
  const paddedW = ceilDiv(w, PATCH_SIZE) * PATCH_SIZE;
  const paddedH = ceilDiv(h, PATCH_SIZE) * PATCH_SIZE;
  const gridW = ceilDiv(Math.floor(paddedW / PATCH_SIZE), DOWNSAMPLE_RATIO);
  const gridH = ceilDiv(Math.floor(paddedH / PATCH_SIZE), DOWNSAMPLE_RATIO);
  const direct = gridH * (gridW + 1) + 2;
  return Math.min(MAX_IMAGE_TOKENS, direct);
}

/**
 * 计算抽帧目标尺寸。
 *
 * 这里有一个**必须记住的计费特性**（实测 + 读源码得到）：
 * 提供方会把小于 544×544（=295936 像素）的图片**放大**到这个下限再算 token。
 * 所以：
 *  - 一帧的 token 有约 184~192 的**地板**，把图缩得比 544×544 更小并不能省钱；
 *  - 反过来，1920×1080 会被压到 1024 token 上限，概览模式没必要花这个钱。
 *
 * 因此：
 *  - `overview`：把超过像素下限的图缩到「约等于下限」，约 192 token/帧，且不自带放大模糊；
 *  - `detail`：只受最大像素约束，需要看清文字/细节时用（最多 1024 token/帧）。
 *
 * @param {number} width
 * @param {number} height
 * @param {object} cfg
 * @param {{ quality?: 'overview'|'detail' }} [options]
 * @returns {{ width: number|null, height: number|null, scaled: boolean, target_pixels: number|null }}
 */
export function targetFrameSize(width, height, cfg, options = {}) {
  const quality = options.quality ?? 'overview';
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: null, height: null, scaled: false, target_pixels: null };
  }
  let w = width;
  let h = height;
  let scaled = false;

  const applyScale = (scale) => {
    const nextW = Math.max(1, Math.round(w * scale));
    const nextH = Math.max(1, Math.round(h * scale));
    if (nextW !== w || nextH !== h) scaled = true;
    w = nextW;
    h = nextH;
  };

  if (quality === 'detail') {
    // 只在超过最大像素时缩，保留细节
    if (w * h > cfg.limits.maxFramePixels) applyScale(Math.sqrt(cfg.limits.maxFramePixels / (w * h)));
  } else {
    // 概览：把像素数压到下限附近（不低于下限，也不浪费在上限外的分辨率）
    if (w * h > MIN_PIXELS) applyScale(Math.sqrt(MIN_PIXELS / (w * h)));
  }

  // 硬宽度上限（配置为 0 表示不限制）
  const maxWidth = cfg.limits.frameMaxWidth;
  if (maxWidth > 0 && w > maxWidth) applyScale(maxWidth / w);
  if (w * h > cfg.limits.maxFramePixels) applyScale(Math.sqrt(cfg.limits.maxFramePixels / (w * h)));

  return {
    width: w,
    height: h,
    scaled,
    target_pixels: w * h,
  };
}

/** 去掉时间上太近的点（默认 150ms 内视为同一时刻）。 */
function dedupeTimestamps(points, minGapMs = 150) {
  const sorted = [...points].sort((a, b) => a.timestampMs - b.timestampMs);
  const out = [];
  for (const point of sorted) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(point.timestampMs - prev.timestampMs) < minGapMs) {
      // 保留更"有理由"的那个（场景切换 > 首尾 > 均匀）
      const rank = { scene_change: 3, first: 2, last: 2, focus: 2, uniform: 1 };
      if ((rank[point.reason] ?? 0) > (rank[prev.reason] ?? 0)) out[out.length - 1] = point;
      continue;
    }
    out.push(point);
  }
  return out;
}

/**
 * 把候选点裁剪到 `count` 个：
 *  优先保首帧、末帧、场景切换点，剩下的位置用均匀点按时间等距填满。
 * 这样"场景切换"是**替换**均匀点，而不是让成本突破用户要求的帧数。
 *
 * 注意：必须**先按时间戳合并**再裁剪。早期版本按「时间戳+理由」去重，
 * 同一时刻既被标成 scene_change 又被标成 last，会占两个名额，裁剪时把末尾点切掉，
 * 直接导致"末帧丢失"（实测 6 帧的 GIF 只抽到 5 帧）。
 */
function capToCount(points, count) {
  const rank = { scene_change: 3, last: 2, first: 2, focus: 2, uniform: 1 };
  const byTimestamp = new Map();
  for (const point of points) {
    const existing = byTimestamp.get(point.timestampMs);
    if (!existing || (rank[point.reason] ?? 0) > (rank[existing.reason] ?? 0)) {
      byTimestamp.set(point.timestampMs, { ...point });
    }
  }
  const merged = [...byTimestamp.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  if (merged.length <= count) return merged;

  const first = merged[0];
  const last = merged[merged.length - 1];
  const keep = new Map();
  keep.set(first.timestampMs, first);
  keep.set(last.timestampMs, last);

  // 场景切换（以及 focus 窗口点）优先占用剩余名额
  for (const point of merged) {
    if (keep.size >= count) break;
    if (point.reason === 'scene_change' || point.reason === 'focus') keep.set(point.timestampMs, point);
  }
  // 还有空位就按时间等距补均匀点
  const rest = merged.filter((point) => !keep.has(point.timestampMs));
  if (keep.size < count && rest.length > 0) {
    const need = count - keep.size;
    for (let i = 0; i < need; i += 1) {
      const index = need === 1 ? Math.floor(rest.length / 2) : Math.round((i * (rest.length - 1)) / Math.max(1, need - 1));
      keep.set(rest[index].timestampMs, rest[index]);
    }
  }
  return [...keep.values()].sort((a, b) => a.timestampMs - b.timestampMs).slice(0, count);
}

/**
 * 把时间戳夹紧到 [0, duration - guard]。
 * 为什么需要：`ffmpeg -ss <duration>` 取不到帧（实测 3.000s 的片子 seek 到 3.000 返回空），
 * 那会让"末帧必取"静默失效、并让覆盖说明说谎。
 *
 * guard 的取值要同时满足两件相反的事：
 *  - 视频：至少留出一帧到两帧的余量（默认下界 50ms），否则 seek 到最后一帧边缘会取空；
 *  - 极短 GIF：绝不吃掉超过 10% 的时长，否则 60ms 的动画会被压成 1 个采样点。
 */
function clampTimestamps(points, durationMs, fps = null) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return points;
  const byFraction = Math.max(1, Math.floor(durationMs * 0.01));
  const byFps = Number.isFinite(fps) && fps > 0 ? Math.ceil(1000 / fps) : 0;
  const raw = Math.max(50, byFraction, byFps);
  const guard = Math.min(raw, Math.max(1, Math.floor(durationMs / 10)));
  const maxTs = Math.max(0, durationMs - guard);
  return points.map((point) => (
    point.timestampMs > maxTs ? { ...point, timestampMs: maxTs, clamped: true } : point
  ));
}

/**
 * 用 ffmpeg 内置 scene 检测找镜头切换点（替代 PySceneDetect）。
 * @returns {Promise<{ ok: boolean, timestampsMs: number[], error?: string, scannedSec?: number }>}
 */
export async function detectSceneChanges(cfg, source, { startMs = 0, endMs = null } = {}) {
  if (!cfg.sampling.sceneDetect) return { ok: true, timestampsMs: [], skipped: 'disabled' };
  const { ffmpeg } = resolveTools(cfg);
  const isRemote = source.kind === 'remote';
  const sourceArgs = isRemote ? remoteProtocolArgs(15000, source.headers) : localProtocolArgs();
  const args = ['-v', 'info', ...sourceArgs];
  if (startMs > 0) args.push('-ss', String(startMs / 1000));
  if (endMs !== null) args.push('-t', String(Math.max(0.1, (endMs - startMs) / 1000)));
  else if (cfg.sampling.sceneDetectMaxDurationSec > 0) args.push('-t', String(cfg.sampling.sceneDetectMaxDurationSec));
  args.push(
    '-i', isRemote ? source.url : source.path,
    '-vf', `select='gt(scene\\,${cfg.sampling.sceneThreshold})',showinfo`,
    '-an', '-f', 'null', '-',
  );
  const result = await run(ffmpeg, args, { timeoutMs: cfg.timeouts.sceneDetectMs });
  const timestamps = [];
  for (const line of String(result.stderr ?? '').split('\n')) {
    if (!line.includes('pts_time:')) continue;
    const match = line.match(/pts_time:([0-9.]+)/);
    if (!match) continue;
    const seconds = Number(match[1]);
    if (!Number.isFinite(seconds)) continue;
    timestamps.push(Math.round((startMs + seconds * 1000)));
  }
  if (result.code !== 0 && timestamps.length === 0) {
    return { ok: false, timestampsMs: [], error: summarizeFailure(result) };
  }
  return { ok: true, timestampsMs: [...new Set(timestamps)].sort((a, b) => a - b) };
}

/**
 * 生成采样计划。
 *
 * @param {object} cfg
 * @param {object} probeResult - probe() 的返回
 * @param {object} [options]
 * @param {'overview'|'focus'|'all'} [options.mode]
 * @param {number} [options.count]
 * @param {number|null} [options.startMs]
 * @param {number|null} [options.endMs]
 * @param {number[]} [options.sceneTimestampsMs]
 * @returns {object} 计划 + 预算 + 覆盖说明
 */
export function planSampling(cfg, probeResult, options = {}) {
  const mode = options.mode ?? 'overview';
  const durationMs = Number(probeResult.duration_ms ?? 0) || null;
  const limitReached = durationMs !== null && durationMs > cfg.limits.maxDurationSec * 1000
    ? cfg.limits.maxDurationSec * 1000
    : null;

  const windowStart = Math.max(0, options.startMs ?? 0);
  const windowEnd = Math.min(
    options.endMs ?? durationMs ?? windowStart,
    limitReached ?? Number.MAX_SAFE_INTEGER,
  );
  const span = Math.max(1, windowEnd - windowStart);

  // 帧数预算
  let count = options.count ?? cfg.limits.defaultFrames;
  count = Math.max(1, Math.min(count, cfg.limits.maxFrames));

  const quality = options.quality === 'detail' ? 'detail' : 'overview';
  const size = targetFrameSize(probeResult.width ?? 0, probeResult.height ?? 0, cfg, { quality });
  const perFrameTokens = cfg.cost.estimateTokens ? estimateImageTokens(size.width ?? 0, size.height ?? 0) : 0;
  const budget = cfg.cost.maxImageTokens;

  // 成本闸门：超出图片预算就减帧
  let budgetNote = null;
  if (perFrameTokens > 0 && budget > 0) {
    const maxAffordable = Math.max(1, Math.floor(budget / perFrameTokens));
    if (count > maxAffordable) {
      budgetNote = `图片 token 预算 ${budget} 只够 ${maxAffordable} 帧（每帧约 ${perFrameTokens}），已从 ${count} 帧减到 ${maxAffordable} 帧`;
      count = maxAffordable;
    }
  }

  /** @type {Array<{timestampMs:number, reason:string}>} */
  const points = [];

  if (mode === 'all' && probeResult.frame_timeline?.length) {
    // 只对很小、很短的动画开放"全帧"
    for (const frame of probeResult.frame_timeline.slice(0, count)) {
      points.push({ timestampMs: frame.ptsMs, reason: 'uniform' });
    }
  } else if (mode === 'focus') {
    // 局部精读：在窗口内均匀加密
    const pad = cfg.sampling.focusPaddingMs;
    const from = Math.max(0, windowStart - pad);
    const to = Math.min(durationMs ?? windowEnd + pad, windowEnd + pad);
    const focusSpan = Math.max(1, to - from);
    for (let i = 0; i < count; i += 1) {
      const ratio = count === 1 ? 0.5 : i / (count - 1);
      points.push({ timestampMs: Math.round(from + focusSpan * ratio), reason: 'focus' });
    }
  } else {
    // 概览：GIF 用时间轴取点；视频用均匀时间点
    const timeline = probeResult.frame_timeline;
    if (timeline?.length) {
      const selected = [];
      // 首帧
      selected.push({ timestampMs: timeline[0].ptsMs, reason: 'first' });
      // 末帧
      if (timeline.length > 1) selected.push({ timestampMs: timeline[timeline.length - 1].ptsMs, reason: 'last' });
      // 按时间比例在时间轴里找最近的帧
      const totalMs = Math.max(1, (timeline[timeline.length - 1].ptsMs - timeline[0].ptsMs) || span);
      for (let i = 1; i < count - 1; i += 1) {
        const target = timeline[0].ptsMs + (totalMs * i) / (count - 1);
        let best = timeline[0];
        for (const frame of timeline) {
          if (Math.abs(frame.ptsMs - target) < Math.abs(best.ptsMs - target)) best = frame;
        }
        selected.push({ timestampMs: best.ptsMs, reason: 'uniform' });
      }
      points.push(...selected);
    } else {
      // 视频：均匀取点（含首尾）
      const from = windowStart;
      const to = windowEnd > from ? windowEnd : from + span;
      for (let i = 0; i < count; i += 1) {
        const ratio = count === 1 ? 0 : i / (count - 1);
        const ts = Math.round(from + (to - from) * ratio);
        const reason = i === 0 ? 'first' : i === count - 1 ? 'last' : 'uniform';
        points.push({ timestampMs: ts, reason });
      }
    }
  }

  // 场景切换点（作为候选加入，最终受 count 约束，见下面的裁剪逻辑）
  const sceneAdded = [];
  const sceneTimestamps = Array.isArray(options.sceneTimestampsMs) ? options.sceneTimestampsMs : [];
  if (sceneTimestamps.length > 0) {
    for (const ts of sceneTimestamps) {
      if (ts < windowStart || ts > (windowEnd || Infinity)) continue;
      sceneAdded.push({ timestampMs: ts, reason: 'scene_change' });
    }
    points.push(...sceneAdded);
  }

  // ── 裁剪到 count：场景切换点不是"额外赠送"，要挤掉均匀点而不是突破成本上限 ──
  const capped = capToCount(points, count);

  // ── 时间戳夹紧：末帧不能正好落在媒体结束时刻（ffmpeg seek 到末尾会取不到帧） ──
  // 注意 dedupe 的间隔：有逐帧时间轴时（GIF/动画），每个采样点都是**精确的某一帧**，
  // 绝不能按"150ms 内算同一时刻"合并 —— 100ms/20ms 延迟的 GIF 会被静默丢掉一半以上的帧
  // （实测 4 帧变 2 帧、3 帧变 1 帧）。视频才用 150ms 去重，避免反复 seek 到相邻时刻。
  const dedupeGapMs = probeResult.frame_timeline?.length > 0 ? 0 : 150;
  const deduped = clampTimestamps(dedupeTimestamps(capped, dedupeGapMs), durationMs, probeResult.fps ?? null);

  // 覆盖说明：诚实标注盲区
  const coveredFrom = deduped.length > 0 ? deduped[0].timestampMs : null;
  const coveredTo = deduped.length > 0 ? deduped[deduped.length - 1].timestampMs : null;
  const gaps = [];
  for (let i = 1; i < deduped.length; i += 1) {
    const gap = deduped[i].timestampMs - deduped[i - 1].timestampMs;
    if (gap > 0) gaps.push(gap);
  }
  const maxGap = gaps.length > 0 ? Math.max(...gaps) : null;

  const notes = [];
  if (deduped.length < count) notes.push(`计划 ${count} 帧，去重后实际 ${deduped.length} 帧`);
  if (maxGap !== null && durationMs) {
    notes.push(`相邻采样点最大间隔约 ${(maxGap / 1000).toFixed(1)}s，短于该间隔的事件可能被漏掉`);
  }
  if (budgetNote) notes.push(budgetNote);
  if (limitReached) notes.push(`媒体超过时长上限，只处理到 ${cfg.limits.maxDurationSec}s`);
  if (probeResult.frame_timeline && probeResult.frame_count && deduped.length < probeResult.frame_count) {
    notes.push(`共 ${probeResult.frame_count} 帧，本次只看 ${deduped.length} 帧，不代表已逐帧检查`);
  }

  return {
    mode,
    requested_count: options.count ?? cfg.limits.defaultFrames,
    plan_count: deduped.length,
    points: deduped,
    window: { start_ms: windowStart, end_ms: windowEnd },
    coverage: {
      first_ms: coveredFrom,
      last_ms: coveredTo,
      max_gap_ms: maxGap,
      covers_full_duration: Boolean(
        durationMs && coveredFrom === 0 && coveredTo !== null && Math.abs(coveredTo - durationMs) < 1200,
      ),
      notes,
    },
    budget: {
      image_tokens_per_frame: perFrameTokens,
      image_tokens_total: perFrameTokens * deduped.length,
      image_token_budget: budget,
      frame_size: { width: size.width, height: size.height, scaled: size.scaled },
    },
    scene_changes_used: sceneAdded.length,
  };
}

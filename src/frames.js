/**
 * 抽帧：把采样计划变成真实的 JPEG 文件。
 *
 * 两个关键实现细节（都来自实测）：
 *  1. **GIF/动画按帧序号取，不按时间 seek**。GIF 帧延迟不均匀，`-ss 1.3` 可能落在
 *     两帧之间或取错帧；用 `select='eq(n,k)'` + `-fps_mode passthrough` 才能精确命中。
 *  2. **ffmpeg 9 已移除 `-vsync`**，必须用 `-fps_mode passthrough`，否则直接报错。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  resolveTools,
  run,
  summarizeFailure,
  localProtocolArgs,
  remoteProtocolArgs,
} from './media.js';

/** 把时间戳映射到时间轴上最近的一帧序号。 */
export function nearestFrameIndex(timeline, timestampMs) {
  if (!Array.isArray(timeline) || timeline.length === 0) return null;
  let best = timeline[0];
  for (const frame of timeline) {
    if (Math.abs(frame.ptsMs - timestampMs) < Math.abs(best.ptsMs - timestampMs)) best = frame;
  }
  return best;
}

function buildSourceArgs(cfg, source, rwTimeoutMs = 15000) {
  return source.kind === 'remote' ? remoteProtocolArgs(rwTimeoutMs, source.headers) : localProtocolArgs();
}

/**
 * 抽帧。
 * @param {object} cfg
 * @param {{kind:'local'|'remote', path?:string, url?:string}} source
 * @param {object} probeResult
 * @param {object} plan - planSampling() 的返回
 * @param {{ taskDir: string }} options
 * @returns {Promise<{ ok: boolean, frames: Array<object>, error?: string, extract_ms: number }>}
 */
export async function extractFrames(cfg, source, probeResult, plan, options = {}) {
  const started = Date.now();
  const taskDir = options.taskDir;
  const frameDir = path.join(taskDir, 'frames');
  fs.mkdirSync(frameDir, { recursive: true });
  for (const existing of fs.readdirSync(frameDir)) {
    try {
      fs.unlinkSync(path.join(frameDir, existing));
    } catch {
      /* 清旧文件失败不影响新任务 */
    }
  }

  const { ffmpeg } = resolveTools(cfg);
  const sourcePath = source.kind === 'remote' ? source.url : source.path;
  const size = plan.budget.frame_size ?? {};
  const scaleFilter = size.width ? `scale=${size.width}:-2:flags=bicubic` : null;
  const timeline = probeResult.frame_timeline;

  // ── 路径 A：有逐帧时间轴（GIF/短动画）→ 一次调用按帧序号取 ──
  if (Array.isArray(timeline) && timeline.length > 0) {
    const wanted = [];
    const seen = new Set();
    for (const point of plan.points) {
      const nearest = nearestFrameIndex(timeline, point.timestampMs);
      if (!nearest || seen.has(nearest.index)) continue;
      seen.add(nearest.index);
      wanted.push({ ...nearest, reason: point.reason, requestedMs: point.timestampMs });
    }
    if (wanted.length === 0) {
      return { ok: false, frames: [], error: '采样计划为空', extract_ms: Date.now() - started };
    }
    const selectExpr = wanted.map((frame) => `eq(n\\,${frame.index})`).join('+');
    const filters = [`select='${selectExpr}'`];
    if (scaleFilter) filters.push(scaleFilter);
    const args = [
      '-v', 'error',
      ...buildSourceArgs(cfg, source),
      '-i', sourcePath,
      '-vf', filters.join(','),
      '-fps_mode', 'passthrough',
      '-q:v', String(cfg.limits.jpegQuality),
      '-y', path.join(frameDir, 'f%03d.jpg'),
    ];
    const result = await run(ffmpeg, args, { timeoutMs: cfg.timeouts.extractMs });
    const files = fs
      .readdirSync(frameDir)
      .filter((name) => /^f\d+\.jpg$/.test(name))
      .sort();
    if (result.code !== 0 && files.length === 0) {
      return { ok: false, frames: [], error: summarizeFailure(result), extract_ms: Date.now() - started };
    }
    const frames = [];
    for (const [position, file] of files.entries()) {
      const spec = wanted[position];
      if (!spec) break;
      const full = path.join(frameDir, file);
      const stat = fs.statSync(full);
      frames.push({
        frame_id: `${path.basename(taskDir)}-frame-${String(spec.index).padStart(4, '0')}`,
        timestamp_ms: spec.ptsMs,
        duration_ms: spec.durationMs,
        source_frame_index: spec.index,
        selection_reason: spec.reason,
        path: full,
        bytes: stat.size,
      });
    }
    return {
      ok: frames.length > 0,
      frames,
      error: frames.length === 0 ? summarizeFailure(result) : undefined,
      extract_ms: Date.now() - started,
      method: 'select-by-index',
      partially_failed: result.code !== 0 && frames.length > 0 ? summarizeFailure(result) : undefined,
    };
  }

  // ── 路径 B：普通视频 → 每个时间点单独 seek（依赖 http range，已验证可用）──
  const frames = [];
  const failures = [];
  for (const [position, point] of plan.points.entries()) {
    const outFile = path.join(frameDir, `f${String(position + 1).padStart(3, '0')}.jpg`);
    const filters = scaleFilter ? ['-vf', scaleFilter] : [];
    const args = [
      '-v', 'error',
      ...buildSourceArgs(cfg, source),
      '-ss', String((point.timestampMs / 1000).toFixed(3)),
      '-i', sourcePath,
      ...filters,
      '-frames:v', '1',
      '-fps_mode', 'passthrough',
      '-q:v', String(cfg.limits.jpegQuality),
      '-y', outFile,
    ];
    const result = await run(ffmpeg, args, { timeoutMs: cfg.timeouts.extractMs });
    if (result.code !== 0 || !fs.existsSync(outFile)) {
      failures.push({ timestamp_ms: point.timestampMs, error: summarizeFailure(result) });
      continue;
    }
    const stat = fs.statSync(outFile);
    if (stat.size === 0) {
      failures.push({ timestamp_ms: point.timestampMs, error: '抽出的文件为空' });
      continue;
    }
    frames.push({
      frame_id: `${path.basename(taskDir)}-frame-${String(position + 1).padStart(4, '0')}`,
      timestamp_ms: point.timestampMs,
      duration_ms: null,
      source_frame_index: null,
      selection_reason: point.reason,
      path: outFile,
      bytes: stat.size,
    });
  }

  return {
    ok: frames.length > 0,
    frames,
    error: frames.length === 0 ? failures[0]?.error ?? '全部抽帧失败' : undefined,
    failures: failures.length > 0 ? failures : undefined,
    extract_ms: Date.now() - started,
    method: 'seek-per-timestamp',
  };
}

/** 把抽出的帧转成 MCP 图片内容块（base64 内联，不依赖外部可访问路径）。 */
export function frameToImageContent(frame) {
  const data = fs.readFileSync(frame.path).toString('base64');
  return {
    type: 'image',
    data,
    mimeType: 'image/jpeg',
  };
}

/** 帧清单（给模型看的文字版，带时间戳与选择理由）。 */
export function describeFrames(frames, { maxChars = 2000 } = {}) {
  const lines = [];
  for (const frame of frames) {
    const seconds = (frame.timestamp_ms / 1000).toFixed(2);
    const reasonMap = {
      first: '首帧',
      last: '末帧',
      uniform: '均匀取样',
      scene_change: '镜头切换',
      focus: '指定时间窗',
    };
    const reason = reasonMap[frame.selection_reason] ?? frame.selection_reason;
    const duration = frame.duration_ms !== null && frame.duration_ms !== undefined ? ` 持续${frame.duration_ms}ms` : '';
    lines.push(`- t=${seconds}s（${reason}${duration}）${frame.frame_id}`);
  }
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（已截断）` : text;
}

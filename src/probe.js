/**
 * 媒体探测：把 ffprobe 的原始输出归一化成插件自己的结构。
 *
 * 关键约定（来自工作流程规范 §2）：
 *  - `access_status` 必须如实反映**到底拿到了什么**，不能把"有标题"当成"看过视频"。
 *  - "拿到媒体 URL" ≠ "解码成功"；这里只报告探测结果，解码成功与否由抽帧步骤证明。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  resolveTools,
  run,
  summarizeFailure,
  localProtocolArgs,
  remoteProtocolArgs,
  sniffFile,
  toolVersions,
} from './media.js';

/** 访问状态枚举（与规范一致）。 */
export const ACCESS_STATUS = Object.freeze([
  'USER_FILE_READY',
  'VIDEO_READY',
  'AUDIO_VIDEO_READY',
  'TRANSCRIPT_READY',
  'METADATA_ONLY',
  'ACCESS_RESTRICTED',
  'ACCESS_FAILED',
]);

/** 把 ffprobe 的 tags/format 里的可疑字段过滤掉（不把 cookie/token 带进日志与结果）。 */
function scrub(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/cookie|token|secret|password|sign|auth|session/i.test(key)) continue;
    out[key] = scrub(item);
  }
  return out;
}

function buildSourceArgs(cfg, source, timeoutMs) {
  if (source.kind === 'local') {
    return { args: [...localProtocolArgs(), '-i', source.path], timeoutMs };
  }
  return { args: [...remoteProtocolArgs(15000, source.headers), '-i', source.url], timeoutMs };
}

/**
 * 跑一次 ffprobe。
 * @returns {Promise<{ ok: boolean, json?: object, error?: string, ms: number }>}
 */
async function ffprobeJson(cfg, source, entries, { timeoutMs } = {}) {
  const { ffprobe } = resolveTools(cfg);
  const isRemote = source.kind === 'remote';
  const effectiveTimeout = timeoutMs ?? (isRemote ? cfg.timeouts.remoteProbeMs : cfg.timeouts.probeMs);
  const base = buildSourceArgs(cfg, source, effectiveTimeout);
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    ...entries,
    ...base.args,
  ];
  const result = await run(ffprobe, args, { timeoutMs: effectiveTimeout });
  if (result.code !== 0) {
    return { ok: false, error: summarizeFailure(result), ms: result.ms, timedOut: result.timedOut };
  }
  try {
    return { ok: true, json: JSON.parse(result.stdout || '{}'), ms: result.ms };
  } catch (error) {
    return { ok: false, error: `ffprobe 输出不是合法 JSON：${String(error?.message ?? error).slice(0, 120)}`, ms: result.ms };
  }
}

/** 逐帧时间轴（GIF 必需；短动画也用它）。 */
export async function probeFrameTimeline(cfg, source, { timeoutMs } = {}) {
  const probe = await ffprobeJson(
    cfg,
    source,
    ['-select_streams', 'v:0', '-show_entries', 'frame=pts_time,pkt_duration_time,best_effort_timestamp_time'],
    { timeoutMs },
  );
  if (!probe.ok) return { ok: false, error: probe.error, frames: [] };
  const raw = Array.isArray(probe.json?.frames) ? probe.json.frames : [];
  const frames = [];
  for (const [index, frame] of raw.entries()) {
    const pts = Number(frame.best_effort_timestamp_time ?? frame.pts_time);
    if (!Number.isFinite(pts)) continue;
    const duration = Number(frame.pkt_duration_time);
    frames.push({
      index,
      ptsMs: Math.round(pts * 1000),
      // 有些容器不给单帧时长，交给调用方用相邻 pts 推导
      durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : null,
    });
  }
  // 用相邻 pts 补齐缺失的帧时长；**最后一帧不借用前一帧**（那会把 200ms 写成 700ms），
  // 留 null 交给 probe() 用容器总时长反推。
  for (let i = 0; i < frames.length; i += 1) {
    if (frames[i].durationMs !== null) continue;
    const next = frames[i + 1];
    frames[i].durationMs = next ? Math.max(0, next.ptsMs - frames[i].ptsMs) : null;
  }
  return { ok: true, frames };
}

/**
 * 完整探测。
 * @param {object} cfg
 * @param {{ kind: 'local'|'remote', path?: string, url?: string, sourceRef?: string, declaredType?: string }} source
 */
export async function probe(cfg, source, options = {}) {
  const started = Date.now();
  const warnings = [];
  const base = {
    ok: false,
    source_type: source.kind === 'local' ? 'local_media' : 'remote_url',
    source_ref: scrub(source.sourceRef ?? source.url ?? source.path ?? ''),
    access_status: 'ACCESS_FAILED',
    duration_ms: null,
    width: null,
    height: null,
    fps: null,
    container: null,
    size_bytes: null,
    tracks: [],
    frame_count: null,
    frame_timeline: null,
    media_kind: null,
    tools: options.tools ?? null,
    warnings,
    error: null,
    probe_ms: 0,
  };

  // ── 本地文件：先做存在性 / 大小 / 类型检查 ──
  if (source.kind === 'local') {
    if (typeof source.path !== 'string' || source.path.length === 0) {
      return { ...base, error: '缺少本地文件路径', probe_ms: Date.now() - started };
    }
    const resolved = path.resolve(source.path);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return { ...base, error: `文件不存在或不可读：${resolved}`, probe_ms: Date.now() - started };
    }
    if (!stat.isFile()) {
      return { ...base, error: `不是普通文件：${resolved}`, probe_ms: Date.now() - started };
    }
    if (stat.size > cfg.limits.maxBytes) {
      return {
        ...base,
        error: `文件 ${stat.size} 字节超过上限 ${cfg.limits.maxBytes}`,
        probe_ms: Date.now() - started,
      };
    }
    base.size_bytes = stat.size;
    const kind = await sniffFile(resolved);
    base.media_kind = kind;
    const ext = path.extname(resolved).toLowerCase();
    if (!cfg.allowedLocalExtensions.includes(ext)) {
      warnings.push(`扩展名 ${ext || '(空)'} 不在允许列表内（仍按内容嗅探结果处理）`);
    }
    if (kind === null && ext !== '.gif') {
      // 嗅探不出也不立刻判死：让 ffprobe 决定（有些容器 magic 不在前 16 字节）
      warnings.push('未识别出已知媒体 magic，交由 ffprobe 判定');
    }
  }

  // ── 容器/流信息 ──
  const containerProbe = await ffprobeJson(cfg, source, ['-show_format', '-show_streams'], {});
  if (!containerProbe.ok) {
    return {
      ...base,
      access_status: 'ACCESS_FAILED',
      error: containerProbe.error,
      probe_ms: Date.now() - started,
      timed_out: Boolean(containerProbe.timedOut),
    };
  }

  const json = containerProbe.json ?? {};
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const format = json.format ?? {};
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  base.tracks = streams.map((s) => ({
    type: s.codec_type,
    codec: s.codec_name ?? null,
    width: s.width ?? null,
    height: s.height ?? null,
    sample_rate: s.sample_rate ?? null,
    channels: s.channels ?? null,
  }));
  base.container = format.format_name ?? null;
  const durationSec = Number(format.duration ?? video?.duration ?? 0);
  if (Number.isFinite(durationSec) && durationSec > 0) {
    base.duration_ms = Math.round(durationSec * 1000);
    if (durationSec > cfg.limits.maxDurationSec) {
      warnings.push(`时长 ${durationSec.toFixed(1)}s 超过上限 ${cfg.limits.maxDurationSec}s；只处理允许范围内的部分`);
    }
  } else if (base.media_kind === 'gif') {
    warnings.push('容器未报告时长（GIF 常见），稍后用帧时间轴计算');
  }

  if (video) {
    base.width = video.width ?? null;
    base.height = video.height ?? null;
    base.codec = video.codec_name ?? null;
    const rate = String(video.avg_frame_rate ?? video.r_frame_rate ?? '');
    const [numRaw, denRaw] = rate.split('/').map(Number);
    base.fps = Number.isFinite(numRaw) && Number.isFinite(denRaw) && denRaw > 0 ? Number((numRaw / denRaw).toFixed(3)) : null;
  }

  // ── GIF / 动画：必须拿到逐帧时间轴，否则无法保证"不是只看第一帧" ──
  const looksAnimated = base.media_kind === 'gif' || /gif|apng|webp/.test(base.container ?? '');
  if (looksAnimated || options.forceTimeline) {
    const timeline = await probeFrameTimeline(cfg, source);
    if (timeline.ok && timeline.frames.length > 0) {
      // 最后一帧的时长若缺失，用容器总时长反推（GIF 的末帧延迟常不出现在逐帧元数据里）
      if (base.duration_ms !== null) {
        const last = timeline.frames[timeline.frames.length - 1];
        if (last.durationMs === null) {
          last.durationMs = Math.max(0, base.duration_ms - last.ptsMs);
          if (last.durationMs === 0) last.durationMs = null;
        }
      }
      base.frame_timeline = timeline.frames;
      base.frame_count = timeline.frames.length;
      const total = timeline.frames.reduce((acc, f) => acc + (f.durationMs ?? 0), 0);
      if (base.duration_ms === null && total > 0) base.duration_ms = total;
      const durations = timeline.frames.map((f) => f.durationMs).filter((d) => d !== null);
      const uneven = new Set(durations).size > 1;
      if (uneven) warnings.push('各帧延迟不一致（已逐帧保留，不要按固定帧率推算时间）');
      if (durations.length < timeline.frames.length) {
        warnings.push(`有 ${timeline.frames.length - durations.length} 帧拿不到时长（时间轴以 pts 为准）`);
      }
    } else {
      warnings.push(`无法取得逐帧时间轴：${timeline.error ?? '未知原因'}`);
    }
  }

  if (!video && !audio) {
    return { ...base, access_status: 'ACCESS_FAILED', error: '未发现可用的音视频轨道', probe_ms: Date.now() - started };
  }

  // ── 状态判定（必须如实） ──
  if (video && audio) base.access_status = 'AUDIO_VIDEO_READY';
  else if (video) base.access_status = 'VIDEO_READY';
  else base.access_status = 'AUDIO_VIDEO_READY';

  // 本地用户提供的文件，状态明确标记为 USER_FILE_READY（来源语义 > 轨道语义）
  if (source.kind === 'local') base.access_status = 'USER_FILE_READY';

  base.ok = true;
  base.probe_ms = Date.now() - started;
  return base;
}

export { toolVersions };

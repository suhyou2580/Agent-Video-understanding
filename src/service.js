/**
 * 服务门面：把探测 / 采样 / 抽帧 / 持久化 / 成本记账串成一次完整调用。
 *
 * 对外只暴露两件事：
 *  - `analyze()`：给定来源，返回"任务 + 帧 + 采样覆盖说明 + 成本估算"；
 *  - `saveEvents()` / `timeline()`：把模型的分析结果结构化落库，并能回读。
 *
 * 这一层**不调用任何模型**。帧以图片内容块交给调用方（MCP 工具）送回模型，
 * 因此不需要额外买视觉 API —— 这是本插件成本结构的核心。
 */

import fs from 'node:fs';
import path from 'node:path';

import { validateConfig } from './config.js';
import { openDatabase, migrate, health as dbHealth } from './db.js';
import * as store from './store.js';
import { probe } from './probe.js';
import { planSampling, detectSceneChanges, estimateImageTokens, targetFrameSize } from './sampling.js';
import { extractFrames } from './frames.js';
import { assertSafeMediaUrl } from './net-guard.js';
import { resolveBilibiliSource, fetchSubtitleText } from './adapters/bilibili.js';
import { hashFile, makeTaskDir, pruneTaskDirs, resolveTools, toolVersions } from './media.js';
import { validateEvents } from './events.js';
import { normalizeTimeline, isCompactEvent, deriveEvidenceFrames, estimateEventTokens, EVENT_KINDS } from './event-format.js';
import { PLUGIN_ROOT, resolveDbPath, resolveWorkDir } from './paths.js';

export const PLUGIN_VERSION = '0.1.0';

function nowIso() {
  return new Date().toISOString();
}

/**
 * 创建服务实例。
 * @param {{ config?: object, configFile?: string, baseDir?: string, databasePath?: string }} [options]
 */
export function createVideoService(options = {}) {
  const baseDir = options.baseDir ?? PLUGIN_ROOT;
  const rawConfig = options.config ?? {};
  const cfg = validateConfig(rawConfig);
  if (!cfg.enabled) {
    return {
      cfg,
      enabled: false,
      close() {},
      health: () => ({ ok: false, enabled: false }),
    };
  }
  const databasePath = options.databasePath ?? resolveDbPath(cfg, baseDir);
  const handle = openDatabase(databasePath);
  migrate(handle);

  let versions = null;
  let versionsAt = 0;

  async function tools() {
    const now = Date.now();
    if (versions && now - versionsAt < 10 * 60 * 1000) return versions;
    versions = await toolVersions(cfg);
    versionsAt = now;
    return versions;
  }

  const service = {
    cfg,
    handle,
    databasePath,
    enabled: true,
    pluginVersion: PLUGIN_VERSION,
    baseDir,

    close() {
      if (!handle.closed) {
        try {
          handle.db.close();
        } catch {
          /* ignore */
        }
        handle.closed = true;
      }
    },

    health() {
      const base = dbHealth(handle);
      const resolved = resolveTools(cfg);
      return {
        ...base,
        ok: base.ok,
        pluginVersion: PLUGIN_VERSION,
        workDir: resolveWorkDir(cfg, baseDir),
        // 这里是"命令是什么"，版本要异步探测，见 toolVersions()
        tools_resolved: resolved,
        cost: store.costStats(handle),
      };
    },

    /** 真正执行 `ffmpeg -version` 拿版本（异步，供 video_doctor 用）。 */
    async toolVersions() {
      return tools();
    },

    stats(opts = {}) {
      return store.costStats(handle, opts);
    },

    /** 只探测，不抽帧（便宜、可先看能不能访问）。 */
    async probeSource(input) {
      const normalized = await normalizeSource(input, cfg);
      if (!normalized.ok) {
        return { ok: false, error: normalized.error, access_status: normalized.access_status ?? 'ACCESS_FAILED', bilibili: normalized.bilibili ?? null };
      }
      const probeResult = await probe(cfg, normalized.source, { tools: await tools() });
      return { ok: probeResult.ok, probe: probeResult, source: normalized.source, bilibili: normalized.bilibili ?? null };
    },

    /**
     * 解析 B 站来源（不抽帧）：元数据 + 能力状态 + 字幕清单。
     * 明确不承诺"任意公开视频都能拿到媒体"。
     */
    async resolveBilibili(input, options = {}) {
      const resolved = await resolveBilibiliSource(input, options);
      return {
        ok: resolved.ok,
        access_status: resolved.access_status,
        error: resolved.error ?? null,
        metadata: resolved.metadata,
        subtitles: resolved.subtitles ?? [],
        has_media: Boolean(resolved.source),
        warnings: resolved.warnings ?? [],
        note: 'access_status 是真实能力：METADATA_ONLY 表示只拿到标题/简介，'
          + 'TRANSCRIPT_READY 表示只拿到字幕，只有 VIDEO_READY/AUDIO_VIDEO_READY 才有画面可分析。',
      };
    },

    /** 取某条字幕的文本（带时间戳），供"只读字幕"路径使用。 */
    async subtitleCues(subtitleUrl) {
      const result = await fetchSubtitleText(subtitleUrl);
      return result;
    },

    /**
     * 完整分析：探测 → 场景检测 → 采样 → 抽帧 → 落库。
     * @param {object} input
     * @param {string} [input.source_path] - 本地文件（用户提供的媒体）
     * @param {string} [input.source_url] - 远程 URL（需通过 net-guard）
     * @param {'overview'|'focus'|'all'} [input.mode]
     * @param {number} [input.count]
     * @param {number} [input.start_ms]
     * @param {number} [input.end_ms]
     * @param {'overview'|'detail'} [input.quality]
     */
    async analyze(input = {}) {
      const normalized = await normalizeSource(input, cfg);
      if (!normalized.ok) {
        return {
          ok: false,
          task_id: null,
          access_status: normalized.access_status ?? 'ACCESS_FAILED',
          error: normalized.error,
          frames: [],
          bilibili: normalized.bilibili ?? null,
          warnings: normalized.bilibili?.warnings ?? [],
        };
      }
      const source = normalized.source;
      const bili = normalized.bilibili ?? null;
      const mode = input.mode ?? 'overview';
      const quality = input.quality === 'detail' ? 'detail' : 'overview';
      const count = Number.isFinite(input.count) ? Number(input.count) : cfg.limits.defaultFrames;
      const startMs = Number.isFinite(input.start_ms) ? Math.max(0, Math.round(input.start_ms)) : null;
      const endMs = Number.isFinite(input.end_ms) ? Math.max(0, Math.round(input.end_ms)) : null;

      // 媒体指纹（本地可算；远程没有本地文件，留空）
      let mediaHash = null;
      if (source.kind === 'local') {
        try {
          mediaHash = await hashFile(source.path);
        } catch {
          mediaHash = null;
        }
      }
      const sourceRef = bili?.metadata?.bvid
        ? `https://www.bilibili.com/video/${bili.metadata.bvid}${bili.metadata.page > 1 ? `?p=${bili.metadata.page}` : ''}`
        : (source.kind === 'local' ? source.path : source.url);
      const cacheKey = store.computeCacheKey({
        mediaHash,
        sourceRef,
        durationMs: input.expected_duration_ms ?? null,
        mode,
        count,
        startMs,
        endMs,
        quality,
        sceneThreshold: cfg.sampling.sceneThreshold,
        pluginVersion: PLUGIN_VERSION,
      });

      // ── 缓存：只复用"帧文件仍然在"的结果 ──
      if (input.use_cache !== false) {
        const cached = store.findByCacheKey(handle, cacheKey);
        if (cached) {
          const cachedFrames = store.listFrames(handle, cached.task_id);
          const filesOk = cachedFrames.length > 0 && cachedFrames.every((frame) => frame.path && fs.existsSync(frame.path));
          if (filesOk) {
            store.recordRun(handle, {
              task_id: cached.task_id,
              mode,
              quality,
              frame_count: cachedFrames.length,
              image_tokens: cachedFrames.reduce((acc, f) => acc + (f.image_tokens ?? 0), 0),
              plugin_version: PLUGIN_VERSION,
              note: 'cache_hit',
            });
            return buildAnalyzeResult({
              service,
              task: store.getTask(handle, cached.task_id),
              frames: cachedFrames,
              plan: cached.probe?.sampling_plan ?? null,
              cached: true,
              warnings: ['命中缓存：本次没有重新抽帧（同一媒体 + 同一采样参数）'],
            });
          }
        }
      }

      // ── 探测 ──
      const probeResult = await probe(cfg, source, { tools: await tools() });
      if (!probeResult.ok) {
        const taskId = store.newTaskId();
        store.insertTask(handle, {
          task_id: taskId,
          source_type: probeResult.source_type,
          source_ref: sourceRef,
          access_status: 'ACCESS_FAILED',
          media_hash: mediaHash,
          duration_ms: probeResult.duration_ms,
          probe_json: { error: probeResult.error, access_status: probeResult.access_status },
          tools_json: await tools(),
          cache_key: null,
        });
        return {
          ok: false,
          task_id: taskId,
          access_status: 'ACCESS_FAILED',
          error: probeResult.error ?? '媒体探测失败',
          frames: [],
          probe: probeResult,
        };
      }

      // ── 场景检测（超长媒体跳过；已有逐帧时间轴的动画也不需要）──
      let sceneResult = { ok: true, timestampsMs: [] };
      const durationSec = (probeResult.duration_ms ?? 0) / 1000;
      if (probeResult.frame_timeline?.length > 0) {
        // GIF/动画：时间轴本身就是精确结构，再扫一遍 scene 只会引入噪声
        sceneResult = { ok: true, timestampsMs: [], skipped: 'has_timeline' };
      } else if (cfg.sampling.sceneDetect && durationSec > 0 && durationSec <= cfg.sampling.sceneDetectMaxDurationSec) {
        sceneResult = await detectSceneChanges(cfg, source, { startMs: startMs ?? 0, endMs: endMs ?? null });
      } else if (durationSec > cfg.sampling.sceneDetectMaxDurationSec) {
        sceneResult = { ok: true, timestampsMs: [], skipped: 'too_long' };
      }

      // ── 采样计划 ──
      const plan = planSampling(cfg, probeResult, {
        mode,
        count,
        startMs,
        endMs,
        sceneTimestampsMs: sceneResult.timestampsMs,
        quality,
      });
      // 用真实目标尺寸重算 token 估算（planSampling 内部按 overview 尺寸算，detail 需要覆盖）
      if (quality === 'detail') {
        const size = targetFrameSize(probeResult.width ?? 0, probeResult.height ?? 0, cfg, { quality: 'detail' });
        const perFrame = estimateImageTokens(size.width ?? 0, size.height ?? 0);
        plan.budget.frame_size = { width: size.width, height: size.height, scaled: size.scaled };
        plan.budget.image_tokens_per_frame = perFrame;
        plan.budget.image_tokens_total = perFrame * plan.plan_count;
      }

      const imageTokensPerFrame = plan.budget.image_tokens_per_frame ?? 0;

      // ── 抽帧 ──
      const taskId = store.newTaskId();
      const taskDir = makeTaskDir(cfg, baseDir, taskId);
      const extracted = await extractFrames(cfg, source, probeResult, plan, { taskDir });

      const size = plan.budget.frame_size ?? {};
      const width = size.width ?? probeResult.width ?? null;
      const height = size.height ?? probeResult.height ?? null;

      const frames = extracted.frames.map((frame) => ({
        ...frame,
        width,
        height,
        image_tokens: cfg.cost.estimateTokens ? estimateImageTokens(width ?? 0, height ?? 0) : 0,
      }));

      // ── 落库 ──
      store.insertTask(handle, {
        task_id: taskId,
        source_type: probeResult.source_type,
        source_ref: sourceRef,
        access_status: probeResult.access_status,
        media_hash: mediaHash,
        duration_ms: probeResult.duration_ms,
        width: probeResult.width,
        height: probeResult.height,
        container: probeResult.container,
        size_bytes: probeResult.size_bytes,
        frame_count: probeResult.frame_count ?? frames.length,
        probe_json: {
          ...summarizeProbe(probeResult),
          bilibili: bili
            ? {
              access_status: bili.access_status,
              metadata: bili.metadata,
              subtitle_langs: (bili.subtitles ?? []).map((item) => item.lan),
              warnings: bili.warnings,
            }
            : null,
          sampling_plan: {
            mode,
            quality,
            plan_count: plan.plan_count,
            coverage: plan.coverage,
            budget: plan.budget,
            scene_changes_used: plan.scene_changes_used,
            scene_skipped: sceneResult.skipped ?? null,
          },
        },
        tools_json: await tools(),
        cache_key: extracted.ok && frames.length > 0 ? cacheKey : null,
      });
      store.replaceFrames(handle, taskId, frames);

      const totalTokens = frames.reduce((acc, frame) => acc + (frame.image_tokens ?? 0), 0);
      store.recordRun(handle, {
        task_id: taskId,
        mode,
        quality,
        frame_count: frames.length,
        image_tokens: totalTokens,
        plugin_version: PLUGIN_VERSION,
        note: extracted.partially_failed ? `partial: ${extracted.partially_failed}` : null,
      });

      const warnings = [...probeResult.warnings];
      if (extracted.failures?.length) {
        warnings.push(`${extracted.failures.length} 个时间点抽帧失败（已跳过，不是"看过了"）`);
      }
      if (sceneResult.error) warnings.push(`场景检测失败：${sceneResult.error}（已退回均匀采样）`);
      if (sceneResult.skipped === 'too_long') {
        warnings.push(`媒体超过 ${cfg.sampling.sceneDetectMaxDurationSec}s，跳过场景检测，只用均匀采样`);
      }

      return buildAnalyzeResult({
        service,
        task: store.getTask(handle, taskId),
        frames,
        plan,
        cached: false,
        warnings,
        extract: extracted,
        error: extracted.ok ? null : extracted.error,
        bilibili: bili,
      });
    },

    /**
     * 保存事件时间线。支持两种输入：
     *  - **紧凑格式**（推荐，省 token）：`[{t:[a,b], e:"…", k:"mv", m:1, a:"cat", c:0.8, w:1, x:1}]`
     *  - 旧的全字段格式（兼容）：`start_ms/end_ms/description/evidence_frame_ids/…`
     *
     * 紧凑格式下：
     *  - 证据帧由**服务端按时间范围派生**（模型不必输出 frame_id，省 ~24 token/条）；
     *  - 不确定度由 confidence 反推（≥0.75 low / ≥0.45 medium / 否则 high），没给就 medium；
     *  - 原始输入无论成功失败都原样进 `media_raw_outputs`（第一层，可清理）。
     */
    saveEvents(taskId, rawEvents, options = {}) {
      const task = store.getTask(handle, taskId);
      if (!task) return { ok: false, error: 'not_found', message: `任务 ${taskId} 不存在` };
      const frames = store.listFrames(handle, taskId);
      const frameIds = new Set(frames.map((frame) => frame.frame_id));

      const list = Array.isArray(rawEvents) ? rawEvents : [];
      const compactMode = list.length > 0 && list.every(isCompactEvent);

      // ── 第一层：原始输出先落库（失败也留，便于复盘模型到底说了什么）──
      let rawId = null;
      try {
        rawId = store.recordRawOutput(handle, {
          taskId,
          kind: compactMode ? 'submit_compact' : 'submit',
          payload: JSON.stringify(rawEvents),
          note: options.note ?? null,
        });
      } catch {
        /* 原始输出落库失败不阻断主流程 */
      }

      let events = [];
      let tokens = 0;
      let warnings = [];

      if (compactMode) {
        const normalized = normalizeTimeline(rawEvents, { durationMs: task.duration_ms });
        warnings = normalized.warnings;
        if (!normalized.ok) {
          store.recordRawOutput(handle, {
            taskId,
            kind: 'rejected',
            payload: JSON.stringify({ issues: normalized.errors }),
            note: 'compact_invalid',
          });
          return { ok: false, error: 'invalid_events', issues: normalized.errors, warnings, raw_id: rawId };
        }
        tokens = normalized.tokens;
        events = normalized.events.map((event) => ({
          start_ms: event.start_ms,
          end_ms: event.end_ms,
          description: event.description,
          evidence_frame_ids: event.explicit_frame_ids?.length
            ? event.explicit_frame_ids.filter((id) => frameIds.has(id))
            : deriveEvidenceFrames(frames, event.start_ms, event.end_ms),
          transcript_refs: [],
          observation_or_inference: event.observation_or_inference,
          uncertainty: event.confidence === null
            ? 'medium'
            : event.confidence >= 0.75 ? 'low' : event.confidence >= 0.45 ? 'medium' : 'high',
          confidence: event.confidence,
          // 库里存**长名**（state/motion/…），方便直接读库与按类型查；短码只在对外格式里用
          kind: event.kind ? EVENT_KINDS[event.kind] : null,
          continuity: event.continuity,
          actor: event.actor,
          worth_memory: event.worth_memory,
          tokens: event.tokens,
        }));
        // 证据帧仍然必须存在（派生失败说明时间范围与帧对不上）
        const missingEvidence = events.filter((event) => event.evidence_frame_ids.length === 0);
        if (missingEvidence.length > 0) {
          warnings.push(`${missingEvidence.length} 条事件派不出证据帧（时间范围与采样帧不重叠），已按最近帧兜底`);
        }
      } else {
        const validation = validateEvents(rawEvents, { durationMs: task.duration_ms, frameIds });
        warnings = validation.warnings;
        if (!validation.ok) {
          store.recordRawOutput(handle, {
            taskId,
            kind: 'rejected',
            payload: JSON.stringify({ issues: validation.errors }),
            note: 'legacy_invalid',
          });
          return { ok: false, error: 'invalid_events', issues: validation.errors, warnings, raw_id: rawId };
        }
        events = validation.events;
        tokens = events.reduce((acc, event) => acc + estimateEventTokens({
          t: event.end_ms === null ? [event.start_ms] : [event.start_ms, event.end_ms],
          e: event.description,
        }), 0);
      }

      const ids = store.replaceEvents(handle, taskId, events);
      return {
        ok: true,
        task_id: taskId,
        saved: ids.length,
        event_ids: ids,
        format: compactMode ? 'compact' : 'legacy',
        timeline_tokens: tokens,
        worth_memory_count: events.filter((event) => event.worth_memory).length,
        warnings,
        raw_id: rawId,
        hint: compactMode
          ? undefined
          : '建议改用紧凑格式：{t:[开始,结束], e:"变化描述", k:"mv", m:1, a:"cat"}，证据帧由服务端派生，可省一半以上 token',
      };
    },

    /** 按"视频 ID / 时间范围 / 数据类型 / 是否值得记忆"查询结构化事件（第二层）。 */
    queryEvents(filter = {}) {
      return { ok: true, events: store.queryEvents(handle, filter) };
    },

    /** 查看某任务的原始模型输出清单（第一层；不含内容正文）。 */
    rawOutputs(taskId) {
      return { ok: true, task_id: taskId, outputs: store.listRawOutputs(handle, taskId) };
    },

    /** 回读时间线。 */
    timeline(taskId) {
      const task = store.getTask(handle, taskId);
      if (!task) return { ok: false, error: 'not_found', message: `任务 ${taskId} 不存在` };
      const frames = store.listFrames(handle, taskId);
      const events = store.listEvents(handle, taskId);
      return {
        ok: true,
        task,
        frames: frames.map((frame) => ({
          frame_id: frame.frame_id,
          timestamp_ms: frame.timestamp_ms,
          duration_ms: frame.duration_ms,
          selection_reason: frame.selection_reason,
          image_tokens: frame.image_tokens,
        })),
        events,
        coverage: task.probe?.sampling_plan?.coverage ?? null,
      };
    },

    /** 取帧的图片内容块（MCP 用）。 */
    frameContents(taskId, { maxFrames } = {}) {
      const frames = store.listFrames(handle, taskId);
      const limit = Math.min(maxFrames ?? frames.length, cfg.limits.maxFrames);
      const out = [];
      for (const frame of frames.slice(0, limit)) {
        if (!frame.path || !fs.existsSync(frame.path)) continue;
        out.push({ frame, path: frame.path });
      }
      return out;
    },

    /** 清理任务及其临时文件。 */
    deleteTask(taskId) {
      const removed = store.deleteTask(handle, taskId);
      try {
        fs.rmSync(path.join(resolveWorkDir(cfg, baseDir), 'tmp', String(taskId)), { recursive: true, force: true });
      } catch {
        /* 文件清理失败不影响数据库删除结果 */
      }
      return { ok: true, task_id: taskId, ...removed };
    },

    /**
     * 清理第一层（临时分析）：帧目录 + 原始模型输出。
     * 事件（第二层）与锚点记忆（第三层）不受影响。
     */
    pruneTemp(opts = {}) {
      const removedDirs = pruneTaskDirs(cfg, baseDir);
      const minutes = Number.isFinite(opts.retentionMinutes)
        ? Number(opts.retentionMinutes)
        : cfg.tempRetentionMinutes;
      const olderThanIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();
      let removedRaw = 0;
      try {
        removedRaw = store.pruneRawOutputs(handle, { olderThanIso });
      } catch {
        /* 清理失败不掩盖主结果 */
      }
      return { ...removedDirs, removed_raw_outputs: removedRaw, retention_minutes: minutes, older_than: olderThanIso };
    },

    recentTasks(limit) {
      return store.recentTasks(handle, limit);
    },
  };

  return service;
}

function summarizeProbe(probeResult) {
  return {
    ok: probeResult.ok,
    source_type: probeResult.source_type,
    access_status: probeResult.access_status,
    duration_ms: probeResult.duration_ms,
    width: probeResult.width,
    height: probeResult.height,
    container: probeResult.container,
    frame_count: probeResult.frame_count ?? null,
    media_kind: probeResult.media_kind ?? null,
    tracks: probeResult.tracks,
    warnings: probeResult.warnings,
    probe_ms: probeResult.probe_ms,
  };
}

function buildAnalyzeResult({ service, task, frames, plan, cached, warnings, extract, error, bilibili = null }) {
  const totalTokens = frames.reduce((acc, frame) => acc + (frame.image_tokens ?? 0), 0);
  return {
    ok: Boolean(task) && frames.length > 0 && !error,
    task_id: task?.task_id ?? null,
    cached,
    access_status: task?.access_status ?? 'ACCESS_FAILED',
    source_type: task?.source_type ?? null,
    bilibili: bilibili
      ? {
        metadata: bilibili.metadata,
        subtitles: bilibili.subtitles ?? [],
        access_status: bilibili.access_status,
      }
      : (task?.probe?.bilibili ?? null),
    duration_ms: task?.duration_ms ?? null,
    width: task?.width ?? null,
    height: task?.height ?? null,
    frame_count: task?.frame_count ?? null,
    frames: frames.map((frame) => ({
      frame_id: frame.frame_id,
      timestamp_ms: frame.timestamp_ms,
      duration_ms: frame.duration_ms,
      selection_reason: frame.selection_reason,
      image_tokens: frame.image_tokens,
      bytes: frame.bytes,
      path: frame.path,
    })),
    sampling: plan
      ? {
        mode: plan.mode,
        plan_count: plan.plan_count,
        coverage: plan.coverage,
        budget: plan.budget,
        scene_changes_used: plan.scene_changes_used,
      }
      : task?.probe?.sampling_plan ?? null,
    cost: {
      image_tokens_total: totalTokens,
      image_tokens_per_frame: frames[0]?.image_tokens ?? 0,
      note: '按 DeepSeek 视觉计费公式估算；真实账单以服务端为准',
    },
    warnings: warnings ?? [],
    error: error ?? null,
    extract_method: extract?.method ?? null,
    extract_ms: extract?.extract_ms ?? null,
  };
}

/**
 * 归一化来源：本地路径 / 远程 URL / B 站链接，并对远程做安全校验。
 * @returns {Promise<{ ok: boolean, source?: object, error?: string, access_status?: string, bilibili?: object }>}
 */
export async function normalizeSource(input, cfg) {
  const hasPath = typeof input.source_path === 'string' && input.source_path.trim().length > 0;
  const hasUrl = typeof input.source_url === 'string' && input.source_url.trim().length > 0;
  const hasBili = typeof input.source_bilibili === 'string' && input.source_bilibili.trim().length > 0;
  const given = [hasPath, hasUrl, hasBili].filter(Boolean).length;
  if (given === 0) return { ok: false, error: '需要 source_path、source_url 或 source_bilibili' };
  if (given > 1) return { ok: false, error: 'source_path / source_url / source_bilibili 只能给一个' };

  if (hasPath) {
    const resolved = path.resolve(input.source_path.trim());
    return { ok: true, source: { kind: 'local', path: resolved } };
  }

  if (hasBili) {
    const resolved = await resolveBilibiliSource(input.source_bilibili.trim(), {
      cid: Number.isFinite(input.cid) ? input.cid : undefined,
      page: Number.isFinite(input.page) ? input.page : undefined,
    });
    if (!resolved.source) {
      // 明确区分"能拿字幕/只能拿元数据"与"完全失败"
      return {
        ok: false,
        error: resolved.error
          ?? (resolved.access_status === 'TRANSCRIPT_READY'
            ? '只拿到字幕，没有可分析的画面（可用 video_bilibili 读取字幕文本）'
            : resolved.access_status === 'METADATA_ONLY'
              ? '只拿到元数据，没有可分析的画面或字幕'
              : 'B 站来源不可用'),
        access_status: resolved.access_status,
        bilibili: { metadata: resolved.metadata, subtitles: resolved.subtitles ?? [], warnings: resolved.warnings ?? [] },
      };
    }
    return {
      ok: true,
      source: resolved.source,
      bilibili: {
        metadata: resolved.metadata,
        subtitles: resolved.subtitles ?? [],
        warnings: resolved.warnings ?? [],
        access_status: resolved.access_status,
      },
    };
  }

  const guard = await assertSafeMediaUrl(input.source_url.trim());
  if (!guard.ok) return { ok: false, error: guard.error };
  return { ok: true, source: { kind: 'remote', url: guard.url.toString(), addresses: guard.addresses } };
}

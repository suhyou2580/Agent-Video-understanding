/**
 * 领域持久化：任务 → 帧证据 → 事件 → 调用成本。
 *
 * 所有写操作都在事务里；所有读取都按 task_id 限定，不存在"跨任务串数据"的查询。
 */

import crypto from 'node:crypto';

import { transaction } from './db.js';
import { scrubUrl } from './media.js';

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** 不可猜测的任务 id。 */
export function newTaskId() {
  const buf = crypto.randomBytes(12);
  let out = '';
  for (const byte of buf) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `V_${out}`;
}

export function newEventId(taskId) {
  return `E_${String(taskId).slice(2, 8)}_${crypto.randomBytes(6).toString('hex')}`;
}

export function newRunId() {
  return `R_${crypto.randomBytes(8).toString('hex')}`;
}

export function newRawId() {
  return `W_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * 缓存键：媒体身份 + 采样参数 + 分析器版本。
 *
 * 只有这些全部一致时结果才可复用 —— 改了帧数/质量/场景阈值都必须重算，
 * 否则会把"只看过 3 帧"的结论当成"看过全片"的结论复用。
 */
export function computeCacheKey(input) {
  const parts = [
    'vdu1',
    input.mediaHash ?? `nohash:${input.sourceRef}`,
    String(input.durationMs ?? ''),
    String(input.mode ?? ''),
    String(input.count ?? ''),
    String(input.startMs ?? ''),
    String(input.endMs ?? ''),
    String(input.quality ?? ''),
    String(input.sceneThreshold ?? ''),
    String(input.pluginVersion ?? ''),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);
}

/** 写入任务行。 */
export function insertTask(handle, task) {
  const now = task.created_at ?? new Date().toISOString();
  handle.db
    .prepare(
      `INSERT INTO media_tasks (task_id, source_type, source_ref, access_status, media_hash, duration_ms,
         width, height, container, size_bytes, frame_count, probe_json, tools_json, cache_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      task.task_id,
      task.source_type,
      scrubUrl(task.source_ref),
      task.access_status,
      task.media_hash ?? null,
      task.duration_ms ?? null,
      task.width ?? null,
      task.height ?? null,
      task.container ?? null,
      task.size_bytes ?? null,
      task.frame_count ?? null,
      task.probe_json ? JSON.stringify(task.probe_json) : null,
      task.tools_json ? JSON.stringify(task.tools_json) : null,
      task.cache_key ?? null,
      now,
      now,
    );
  return task.task_id;
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapTask(row) {
  if (!row) return null;
  return {
    ...row,
    probe: parseJson(row.probe_json, null),
    tools: parseJson(row.tools_json, null),
    probe_json: undefined,
    tools_json: undefined,
  };
}

export function getTask(handle, taskId) {
  return mapTask(handle.db.prepare('SELECT * FROM media_tasks WHERE task_id = ?').get(String(taskId)));
}

/** 按缓存键找最近一次成功的任务（只复用 access_status 不是失败的结果）。 */
export function findByCacheKey(handle, cacheKey) {
  if (!cacheKey) return null;
  return mapTask(
    handle.db
      .prepare(
        `SELECT * FROM media_tasks
         WHERE cache_key = ? AND access_status NOT IN ('ACCESS_FAILED','METADATA_ONLY')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(cacheKey),
  );
}

export function updateTask(handle, taskId, patch) {
  const fields = [];
  const values = [];
  const allowed = new Set(['frame_count', 'duration_ms', 'width', 'height', 'access_status', 'probe_json', 'cache_key']);
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key)) throw new Error(`updateTask 不允许更新 ${key}`);
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return 0;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString(), String(taskId));
  return Number(handle.db.prepare(`UPDATE media_tasks SET ${fields.join(', ')} WHERE task_id = ?`).run(...values).changes ?? 0);
}

/** 写帧（同任务先清空，避免重跑留下旧帧）。 */
export function replaceFrames(handle, taskId, frames) {
  const now = new Date().toISOString();
  transaction(handle, () => {
    handle.db.prepare('DELETE FROM media_frames WHERE task_id = ?').run(String(taskId));
    const stmt = handle.db.prepare(
      `INSERT INTO media_frames (frame_id, task_id, timestamp_ms, duration_ms, source_frame_index,
         selection_reason, path, bytes, width, height, image_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const frame of frames) {
      stmt.run(
        frame.frame_id,
        String(taskId),
        frame.timestamp_ms,
        frame.duration_ms ?? null,
        frame.source_frame_index ?? null,
        frame.selection_reason ?? 'uniform',
        frame.path ?? null,
        frame.bytes ?? null,
        frame.width ?? null,
        frame.height ?? null,
        frame.image_tokens ?? null,
        now,
      );
    }
  });
  return frames.length;
}

export function listFrames(handle, taskId) {
  return handle.db
    .prepare('SELECT * FROM media_frames WHERE task_id = ? ORDER BY timestamp_ms ASC')
    .all(String(taskId));
}

/** 帧 id 集合（校验证据引用用）。 */
export function frameIdSet(handle, taskId) {
  return new Set(listFrames(handle, taskId).map((row) => row.frame_id));
}

/** 写事件（全量替换，保持"一次提交即当前时间线"的语义）。 */
export function replaceEvents(handle, taskId, events) {
  const now = new Date().toISOString();
  const ids = [];
  transaction(handle, () => {
    handle.db.prepare('DELETE FROM media_events WHERE task_id = ?').run(String(taskId));
    const stmt = handle.db.prepare(
      `INSERT INTO media_events (event_id, task_id, start_ms, end_ms, description, evidence_frame_ids,
         transcript_refs, observation_or_inference, uncertainty, confidence, created_at,
         kind, continuity, actor, worth_memory, tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const event of events) {
      const eventId = event.event_id ?? newEventId(taskId);
      stmt.run(
        eventId,
        String(taskId),
        event.start_ms,
        event.end_ms ?? null,
        event.description,
        JSON.stringify(event.evidence_frame_ids ?? []),
        JSON.stringify(event.transcript_refs ?? []),
        event.observation_or_inference,
        event.uncertainty ?? 'medium',
        event.confidence ?? null,
        now,
        event.kind ?? null,
        event.continuity ?? null,
        event.actor ?? null,
        event.worth_memory ? 1 : 0,
        event.tokens ?? null,
      );
      ids.push(eventId);
    }
  });
  return ids;
}

export function listEvents(handle, taskId) {
  return handle.db
    .prepare('SELECT * FROM media_events WHERE task_id = ? ORDER BY start_ms ASC')
    .all(String(taskId))
    .map((row) => ({
      ...row,
      worth_memory: row.worth_memory ? 1 : 0,
      evidence_frame_ids: parseJson(row.evidence_frame_ids, []),
      transcript_refs: parseJson(row.transcript_refs, []),
    }));
}

/**
 * 按"视频 ID + 时间范围 + 数据类型"查询事件（第二层储存的检索入口）。
 * @param {object} handle
 * @param {{ taskId?: string, fromMs?: number, toMs?: number, kind?: string, worthMemory?: boolean, limit?: number }} filter
 */
export function queryEvents(handle, filter = {}) {
  const where = [];
  const params = [];
  if (filter.taskId) {
    where.push('task_id = ?');
    params.push(String(filter.taskId));
  }
  if (Number.isFinite(filter.fromMs)) {
    // 与查询窗口有交集的事件：结束时间缺失时用开始时间比较
    where.push('COALESCE(end_ms, start_ms) >= ?');
    params.push(Number(filter.fromMs));
  }
  if (Number.isFinite(filter.toMs)) {
    where.push('start_ms <= ?');
    params.push(Number(filter.toMs));
  }
  if (filter.kind) {
    where.push('kind = ?');
    params.push(String(filter.kind));
  }
  if (filter.worthMemory === true) where.push('worth_memory = 1');
  const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
  const sql = `SELECT * FROM media_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY start_ms ASC LIMIT ?`;
  return handle.db
    .prepare(sql)
    .all(...params, limit)
    .map((row) => ({
      event_id: row.event_id,
      task_id: row.task_id,
      start_ms: row.start_ms,
      end_ms: row.end_ms,
      description: row.description,
      kind: row.kind,
      continuity: row.continuity,
      actor: row.actor,
      observation_or_inference: row.observation_or_inference,
      uncertainty: row.uncertainty,
      confidence: row.confidence,
      worth_memory: row.worth_memory ? 1 : 0,
      tokens: row.tokens,
      evidence_frame_ids: parseJson(row.evidence_frame_ids, []),
    }));
}

// ── 第一层：临时分析（原始模型输出，按保留策略清理）─────────────────────────

/**
 * 保存一条原始模型输出。
 * 用途：复盘"模型到底输出了什么"、被拒原文、以及调试时对照结构化结果。
 * 不参与召回，也不进长期记忆。
 */
export function recordRawOutput(handle, { taskId, kind = 'submit', payload, tokens = null, note = null }) {
  const rawId = newRawId();
  handle.db
    .prepare(
      `INSERT INTO media_raw_outputs (raw_id, task_id, kind, payload, tokens, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(rawId, String(taskId), kind, String(payload).slice(0, 20000), tokens, note, new Date().toISOString());
  return rawId;
}

export function listRawOutputs(handle, taskId, limit = 20) {
  return handle.db
    .prepare('SELECT raw_id, kind, tokens, note, created_at FROM media_raw_outputs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(String(taskId), Math.min(Math.max(Number(limit) || 20, 1), 100));
}

/** 按保留期清理原始输出（第一层）。事件与记忆不受影响。 */
export function pruneRawOutputs(handle, { olderThanIso, limit = 500 }) {
  const removed = handle.db
    .prepare(
      `DELETE FROM media_raw_outputs WHERE created_at < ?`,
    )
    .run(olderThanIso).changes;
  void limit;
  return Number(removed ?? 0);
}

/** 记录一次分析调用（成本记账）。 */
export function recordRun(handle, run) {
  const runId = run.run_id ?? newRunId();
  handle.db
    .prepare(
      `INSERT INTO analysis_runs (run_id, task_id, mode, quality, frame_count, image_tokens,
         plugin_version, model, prompt_version, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      String(run.task_id),
      run.mode ?? 'overview',
      run.quality ?? null,
      run.frame_count ?? 0,
      run.image_tokens ?? 0,
      run.plugin_version ?? null,
      run.model ?? null,
      run.prompt_version ?? null,
      run.note ? String(run.note).slice(0, 500) : null,
      new Date().toISOString(),
    );
  return runId;
}

/** 成本与失败率统计（意见稿 §7.2 要求）。 */
export function costStats(handle, { sinceIso = null } = {}) {
  const where = sinceIso ? 'WHERE created_at >= ?' : '';
  const params = sinceIso ? [sinceIso] : [];
  const runs = handle.db
    .prepare(
      `SELECT COUNT(*) AS runs, COALESCE(SUM(frame_count),0) AS frames,
              COALESCE(SUM(image_tokens),0) AS image_tokens,
              COALESCE(AVG(image_tokens),0) AS avg_tokens
       FROM analysis_runs ${where}`,
    )
    .get(...params);
  const tasks = handle.db
    .prepare(`SELECT access_status, COUNT(*) AS c FROM media_tasks ${where} GROUP BY access_status`)
    .all(...params);
  const cacheHits = handle.db
    .prepare(`SELECT COUNT(*) AS c FROM analysis_runs ${where ? `${where} AND` : 'WHERE'} note = 'cache_hit'`)
    .get(...params).c;
  const total = tasks.reduce((acc, row) => acc + Number(row.c), 0);
  const failed = tasks.find((row) => row.access_status === 'ACCESS_FAILED')?.c ?? 0;
  return {
    runs: Number(runs.runs),
    frames_seen: Number(runs.frames),
    image_tokens_total: Number(runs.image_tokens),
    image_tokens_avg: Number(Number(runs.avg_tokens).toFixed(1)),
    cache_hits: Number(cacheHits),
    tasks_total: total,
    tasks_failed: Number(failed),
    failure_rate: total === 0 ? null : Number((Number(failed) / total).toFixed(4)),
    by_status: Object.fromEntries(tasks.map((row) => [row.access_status, Number(row.c)])),
  };
}

export function recentTasks(handle, limit = 10) {
  return handle.db
    .prepare(
      `SELECT task_id, source_type, source_ref, access_status, duration_ms, frame_count, created_at
       FROM media_tasks ORDER BY created_at DESC LIMIT ?`,
    )
    .all(Math.min(Math.max(Number(limit) || 10, 1), 100));
}

/** 删除任务及其帧/事件（临时文件由调用方清理）。 */
export function deleteTask(handle, taskId) {
  let frames = 0;
  let events = 0;
  transaction(handle, () => {
    frames = Number(handle.db.prepare('DELETE FROM media_frames WHERE task_id = ?').run(String(taskId)).changes ?? 0);
    events = Number(handle.db.prepare('DELETE FROM media_events WHERE task_id = ?').run(String(taskId)).changes ?? 0);
    handle.db.prepare('DELETE FROM analysis_runs WHERE task_id = ?').run(String(taskId));
    handle.db.prepare('DELETE FROM media_tasks WHERE task_id = ?').run(String(taskId));
  });
  return { frames, events };
}

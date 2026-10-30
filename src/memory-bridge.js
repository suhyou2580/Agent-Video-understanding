/**
 * 与锚点记忆插件的对接（明确接口，不做数据库层面的偷看）。
 *
 * 依赖方向：视频插件 → 记忆插件（单向），通过记忆插件自己导出的 `service.js`。
 * 找不到记忆插件时**不影响视频能力**：`video_remember` 返回明确错误，
 * 其余工具照常工作（意见稿：可选依赖不得阻塞主链路）。
 *
 * 路径解析顺序：
 *   1. 调用方注入的 memoryService（测试与宿主共享实例）
 *   2. 环境变量 ANCHOR_MEMORY_DIR
 *   3. 同级目录 ../anchor-memory（默认布局）
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PLUGIN_ROOT } from './paths.js';

let cached = null;

/**
 * 解析记忆插件并取其服务单例。
 * @param {{ memoryService?: object, dir?: string, configFile?: string }} [options]
 * @returns {Promise<{ ok: boolean, service?: object, error?: string, source?: string }>}
 */
export async function resolveMemory(options = {}) {
  if (options.memoryService) return { ok: true, service: options.memoryService, source: 'injected' };
  if (cached) return cached;

  const candidates = [];
  if (Array.isArray(options.dirs)) {
    // 显式候选列表（测试用）：不做默认同级目录回落
    candidates.push(...options.dirs);
  } else {
    if (options.dir) candidates.push(options.dir);
    if (process.env.ANCHOR_MEMORY_DIR) candidates.push(process.env.ANCHOR_MEMORY_DIR);
    candidates.push(path.resolve(PLUGIN_ROOT, '..', 'anchor-memory'));
  }

  for (const dir of candidates) {
    const entry = path.join(dir, 'src', 'service.js');
    if (!fs.existsSync(entry)) continue;
    try {
      const module = await import(pathToFileURL(entry).href);
      const service = module.getMemoryService({
        configFile: options.configFile ?? process.env.ANCHOR_MEMORY_CONFIG ?? path.join(dir, 'config.json'),
        baseDir: dir,
      });
      cached = { ok: true, service, source: dir };
      return cached;
    } catch (error) {
      cached = { ok: false, error: `记忆插件加载失败（${dir}）：${String(error?.message ?? error)}` };
      return cached;
    }
  }
  cached = {
    ok: false,
    error: '未找到锚点记忆插件：请把 anchor-memory 放在同级目录，或设置 ANCHOR_MEMORY_DIR',
  };
  return cached;
}

export function resetMemoryCache() {
  cached = null;
}

/**
 * 把一次视频分析的结论写成一条结构化记忆（第三层：只存对将来有交互价值的信息）。
 *
 * 取舍（按需求）：
 *  - **默认只写"值得记住"的事件**（`w:1`）。用户没有明确要求时，不把整条时间线灌进长期记忆；
 *  - 一条任务最多写**一条**摘要记忆（标题/来源/关键时间点/覆盖范围），事件细节留在第二层
 *    `media_events`，需要时用 `video_query_events` 按视频 ID 回读；
 *  - `force: true` 才在没有任何 `w:1` 事件时也写入（用于用户明确说"记住这个视频"）。
 *
 * @param {object} params
 * @param {object} params.task - media_tasks 行
 * @param {object[]} params.events - media_events 行
 * @param {string} [params.summary] - 覆盖默认摘要
 * @param {boolean} [params.force] - 用户明确要求时才 true
 * @param {string} [params.scope]
 * @param {object} [params.memoryService]
 */
export async function rememberVideo({ task, events = [], summary = null, force = false, scope, memoryService = null, dirs = null }) {
  const memory = await resolveMemory(dirs ? { dirs } : { memoryService });
  if (!memory.ok) {
    return { ok: false, error: 'memory_unavailable', message: memory.error };
  }
  const service = memory.service;
  if (!service || service.cfg?.enabled === false) {
    return { ok: false, error: 'memory_disabled', message: '记忆插件已停用' };
  }

  const title = task?.probe?.bilibili?.metadata?.title
    ?? (task?.source_type === 'local_media' && task?.source_ref
      // 本地文件只写文件名：长期记忆里不该出现用户磁盘上的完整路径
      ? path.basename(String(task.source_ref))
      : task?.source_ref ?? '视频');
  const seconds = (ms) => (ms === null || ms === undefined ? '?' : (ms / 1000).toFixed(1));
  // 第三层只收"值得记"的事件；没有就默认不写（除非用户明确要求）
  const observations = events.filter((event) => event.observation_or_inference === 'observation');
  const worth = observations.filter((event) => event.worth_memory === 1);
  if (worth.length === 0 && !force) {
    return {
      ok: false,
      error: 'nothing_worth_remembering',
      message: '本次没有标记 w:1 的事件，按"只存有交互价值的信息"的规则不写入长期记忆',
      hint: '如果确实要记住这个视频，重新调用时传 force:true；或者先给关键事件加 w:1 再存',
      observation_count: observations.length,
    };
  }
  const picked = (worth.length > 0 ? worth : observations).slice(0, 8);

  const lines = [];
  lines.push(`看了《${title}》`);
  if (task?.duration_ms) lines.push(`时长 ${seconds(task.duration_ms)}s`);
  lines.push(`来源 ${task.source_ref}`);
  if (task?.task_id) lines.push(`任务 ${task.task_id}`);

  if (picked.length > 0) {
    lines.push(worth.length > 0 ? '值得记住：' : '观察到：');
    for (const event of picked) {
      const kind = event.kind ? `[${event.kind}]` : '';
      const actor = event.actor ? `${event.actor} ` : '';
      lines.push(`- ${seconds(event.start_ms)}–${seconds(event.end_ms ?? event.start_ms)}s ${kind}${actor}${event.description}`);
    }
  }
  const inferences = events.filter((event) => event.observation_or_inference === 'inference').length;
  if (inferences > 0) lines.push(`另有 ${inferences} 条推断（未写入）`);

  const coverage = task?.probe?.sampling_plan?.coverage;
  if (coverage) {
    lines.push(`覆盖 ${seconds(coverage.first_ms)}–${seconds(coverage.last_ms)}s`
      + `${coverage.covers_full_duration ? '（全片范围）' : '（未覆盖全片）'}`);
  }
  const canonicalText = summary ?? lines.join('；');
  if (canonicalText.length > 380) {
    return { ok: false, error: 'summary_too_long', message: '摘要超过 380 字符，请传更短的 summary' };
  }

  const result = service.writeStructured({
    memoryType: 'event',
    tier: 'normal',
    sourceType: 'imported',
    sourceRef: task.source_ref,
    canonicalText,
    summary: canonicalText.slice(0, 160),
    payload: {
      subject: '主人',
      action: 'video_analyzed',
      object: String(title).slice(0, 40),
      status: 'completed',
    },
    confidence: 0.9,
  }, { scope });

  if (!result?.ok) {
    // 统一成 memory_write_failed，并把底层错误码放在 cause 里（便于排查，又不让上层
    // 依赖记忆插件的内部错误码）
    return {
      ok: false,
      error: 'memory_write_failed',
      cause: result?.error ?? null,
      message: result?.message ?? '记忆写入失败',
      details: result,
    };
  }
  return {
    ok: true,
    node_id: result.node_id,
    state: result.state,
    owner_scope: result.owner_scope,
    memory_source: memory.source,
    written_text: canonicalText,
    note: '只写入一条摘要记忆；事件级细节仍保存在视频插件的 media_events 表，用 video_timeline 回读。',
  };
}

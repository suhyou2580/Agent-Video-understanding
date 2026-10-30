/**
 * MCP 工具层。
 *
 * 为什么用 MCP 而不是 DSH 原生工具：QQ 会话有执行期工具白名单，只放行
 * mcp__snowluma__ / mcp__snowluma-host__ / mcp__web-search-safe__ / mcp__phone__。
 * 新开 serverName 会被拒绝执行；所以本插件挂到既有的 `snowluma-host` server 上。
 *
 * **成本模型（核心设计）**：本插件不调用任何视觉 API。它把关键帧作为图片内容块
 * 交给当前会话的模型去"看"——如果模型本身支持图片输入（DeepSeek 支持），
 * 就零额外服务、零重复提示词。插件只负责把 token 花得最少：
 *   - 概览模式把画面压到计费地板（约 192 token/帧）；
 *   - 帧数有硬上限，超预算自动减帧；
 *   - 同一媒体 + 同一参数命中缓存，不重复抽帧。
 */

import fs from 'node:fs';

import { createVideoService } from './service.js';
import { estimateImageTokens } from './sampling.js';
import { rememberVideo } from './memory-bridge.js';
import { createLogger } from './log.js';

const log = createLogger();

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(code, message, extra = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: code, message, ...extra }, null, 2) }],
    isError: true,
  };
}

function seconds(ms) {
  return ms === null || ms === undefined ? null : Number((ms / 1000).toFixed(2));
}

/** 展示用：固定两位小数，保证「t=1.00s」这种时间戳可被稳定引用。 */
function formatSeconds(ms) {
  return ms === null || ms === undefined ? '?' : (ms / 1000).toFixed(2);
}

/** 工具规格（JSON-Schema 子集，便于转成 zod 且可被测试直接断言）。 */
export const videoToolSpecs = [
  {
    name: 'video_probe',
    description:
      '探测来源、时长、分辨率、轨道与可访问状态（不抽帧、不花图片 token）。'
      + '接受本地路径、远程 URL 或 B 站链接。access_status 是真实能力：'
      + 'METADATA_ONLY / TRANSCRIPT_READY 都还没看到画面，ACCESS_FAILED 表示没拿到。',
    inputSchema: {
      type: 'object',
      properties: {
        source_path: { type: 'string', description: '本地媒体文件路径（用户提供的 GIF/视频）' },
        source_url: { type: 'string', description: '远程媒体 URL（http/https，需通过内网校验）' },
        source_bilibili: { type: 'string', description: 'B 站视频链接或 BV/av 号（网页播放器公开接口，非官方开放平台）' },
      },
    },
  },
  {
    name: 'video_bilibili',
    description:
      '解析 B 站视频：元数据、能力状态、字幕清单。用的是网页播放器公开接口，'
      + '不绕过登录/付费/DRM/风控；没有画面时只按标题与简介说，不许描述画面。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'B 站链接或 BV/av 号' },
        page: { type: 'number', description: '分P序号（从 1 开始）' },
        fetch_subtitle: { type: 'boolean', description: 'true 时抓取一条字幕的时间轴文本（可能很长，默认 false）' },
        subtitle_lan: { type: 'string', description: '指定字幕语言，如 zh-CN / ai-zh' },
      },
      required: ['target'],
    },
  },
  {
    name: 'video_frames',
    description:
      '抽取带时间戳的关键帧并**直接把图片给你看**（概览模式约 192 token/帧）。'
      + '看视频画面的主入口：先用概览，再针对某段时间用 mode=focus 加密。'
      + '返回带 frame_id、时间戳与覆盖范围；没覆盖到的地方不算看过。'
      + '传 task_id 可复用已抽好的帧，避免重复花钱。',
    inputSchema: {
      type: 'object',
      properties: {
        source_path: { type: 'string', description: '本地媒体文件路径' },
        source_url: { type: 'string', description: '远程媒体 URL' },
        source_bilibili: { type: 'string', description: 'B 站链接或 BV 号（会先解析媒体地址再抽帧）' },
        task_id: { type: 'string', description: '已存在的任务 id：只回取该任务已抽好的帧' },
        count: { type: 'number', description: '想要几帧（默认 6，上限 16）' },
        mode: { type: 'string', enum: ['overview', 'focus', 'all'], description: 'overview=全片概览；focus=指定时间窗加密；all=逐帧（仅小 GIF）' },
        start_ms: { type: 'number', description: 'focus 模式的时间窗起点（毫秒）' },
        end_ms: { type: 'number', description: 'focus 模式的时间窗终点（毫秒）' },
        quality: { type: 'string', enum: ['overview', 'detail'], description: 'overview=省 token（约 192/帧）；detail=保留细节看清文字（最多 1024/帧）' },
      },
    },
  },
  {
    name: 'video_save_events',
    description:
      '保存你从帧里看出的**变化时间线**，不是逐帧描述。'
      + '证据帧由服务端按时间范围自动绑定，不需要你给；整条超过约 400 token 会被拒收。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'video_frames 返回的任务 id' },
        events: {
          type: 'array',
          description:
            '按时间顺序。必填 t=[开始毫秒,结束毫秒]、e=变化描述（≤20字，如"平趴→支起抬头"）。'
            + '可选：k=mv动作/st状态/ap出现/ds消失/tr转变/sc场景切换、m=0单次/1连续/2重复、'
            + 'a=角色（单主体省略）、c=置信度0~1（拿不准才写）、w=1值得长期记住、x=1是推断。'
            + '一条约 25~50 token，别写证据帧 id。',
          items: { type: 'object' },
        },
      },
      required: ['task_id', 'events'],
    },
  },
  {
    name: 'video_query_events',
    description: '按视频 ID / 时间范围 / 数据类型回查已保存的事件；不抽帧、不花 token。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '视频任务 id（可只按它查全片）' },
        from_ms: { type: 'number', description: '时间范围起点（毫秒）' },
        to_ms: { type: 'number', description: '时间范围终点（毫秒）' },
        kind: { type: 'string', enum: ['motion', 'state', 'appear', 'disappear', 'transform', 'scene_change'], description: '数据类型' },
        worth_memory: { type: 'boolean', description: '只返回标记为值得记忆的事件' },
        limit: { type: 'number', description: '最多返回条数（默认 50）' },
      },
    },
  },
  {
    name: 'video_timeline',
    description: '回读某个视频任务已保存的事件时间线与帧证据清单（不重新抽帧、不花 token）。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'video_remember',
    description:
      '把这次结论写进长期记忆，一条任务只写一条摘要。默认只收标了 w:1 的事件；'
      + '没有 w:1 就不写（事件细节留在 video_query_events 里按视频 ID 回查）。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'video_frames 返回的任务 id' },
        summary: { type: 'string', description: '可选：自定义摘要（≤380 字符）' },
        force: { type: 'boolean', description: 'true 才在没有任何 w:1 事件时也写入；只在用户明确要求"记住这个视频"时用' },
        scope: { type: 'string', description: '记忆隔离范围，默认与记忆插件配置一致' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'video_stats',
    description: '视频理解的成本与失败率统计：抽帧次数、看过多少帧、图片 token 总计/平均、缓存命中、失败率。',
    inputSchema: {
      type: 'object',
      properties: {
        since_days: { type: 'number', description: '只统计最近 N 天（默认全部）' },
      },
    },
  },
  {
    name: 'video_doctor',
    description: '自检：ffmpeg/ffprobe 是否可用及版本、数据库健康、当前配置上限（排障先跑这个）。',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** 进程内单例（MCP server 与其它宿主共用同一个库连接）。 */
let singleton = null;

export function getVideoService(options = {}) {
  if (!singleton) singleton = createVideoService(options);
  if (options.memoryService) singleton.memoryService = options.memoryService;
  return singleton;
}

export function resetVideoService() {
  if (singleton) {
    try {
      singleton.close();
    } catch {
      /* ignore */
    }
  }
  singleton = null;
}

function formatAnalyzeText(result) {
  const lines = [];
  lines.push(`任务 ${result.task_id}｜${result.access_status}｜${result.cached ? '缓存命中' : '新抽帧'}`);
  if (result.bilibili?.metadata) {
    const meta = result.bilibili.metadata;
    lines.push(`来源：B站 ${meta.bvid ?? ''}${meta.page > 1 ? ` P${meta.page}` : ''}｜${meta.title ?? ''}`
      + `${meta.owner ? `｜UP: ${meta.owner}` : ''}`);
    if (meta.page_title) lines.push(`分P：${meta.page_title}`);
    if (result.bilibili.subtitles?.length > 0) {
      lines.push(`字幕可用：${result.bilibili.subtitles.map((s) => s.lan).join(', ')}（可让我读字幕，不需要抽帧）`);
    }
    lines.push('注意：B 站来源使用网页播放器公开接口，不是官方开放平台 API。');
  }
  const meta = [];
  if (result.duration_ms !== null) meta.push(`时长 ${formatSeconds(result.duration_ms)}s`);
  if (result.width) meta.push(`${result.width}x${result.height}`);
  if (result.frame_count !== null) meta.push(`源帧数 ${result.frame_count}`);
  if (meta.length) lines.push(meta.join('｜'));
  if (result.sampling) {
    lines.push(`采样：${result.sampling.mode}｜本次看 ${result.sampling.plan_count} 帧｜图片约 ${result.cost.image_tokens_total} token`);
    const coverage = result.sampling.coverage;
    if (coverage) {
      lines.push(`覆盖：${formatSeconds(coverage.first_ms)}s → ${formatSeconds(coverage.last_ms)}s`
        + `${coverage.covers_full_duration ? '（覆盖全片范围）' : '（未覆盖全片）'}`);
      for (const note of coverage.notes ?? []) lines.push(`注意：${note}`);
    }
  }
  lines.push('');
  lines.push('帧清单（严格按下面顺序给你，第 N 条对应第 N 张图）：');
  for (const [index, frame] of result.frames.entries()) {
    const reasonMap = { first: '首帧', last: '末帧', uniform: '均匀取样', scene_change: '镜头切换', focus: '指定时间窗' };
    lines.push(
      `${index + 1}. t=${formatSeconds(frame.timestamp_ms)}s（${reasonMap[frame.selection_reason] ?? frame.selection_reason}）`
      + ` frame_id=${frame.frame_id}`,
    );
  }
  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('限制与警告：');
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }
  lines.push('');
  lines.push('提醒：这些是采样帧，短于采样间隔的动作可能没被拍到；不确定的地方要说不确定，'
    + '不要把推测写成已看到的事实。');
  return lines.join('\n');
}

/**
 * 执行一个工具。
 * @param {string} toolName
 * @param {object} args
 * @param {object} [service]
 */
export async function invokeVideoTool(toolName, args = {}, service = null) {
  const svc = service ?? getVideoService();
  const a = args && typeof args === 'object' ? args : {};

  switch (toolName) {
    case 'video_probe': {
      const result = await svc.probeSource({
        source_path: a.source_path,
        source_url: a.source_url,
        source_bilibili: a.source_bilibili,
      });
      if (!result.ok) {
        return fail('probe_failed', result.probe?.error ?? result.error ?? '探测失败', {
          access_status: result.access_status ?? null,
          probe: result.probe ?? null,
          bilibili: result.bilibili ?? null,
        });
      }
      const probe = result.probe;
      return ok({
        ok: true,
        access_status: probe.access_status,
        source_type: probe.source_type,
        source_ref: probe.source_ref,
        duration_ms: probe.duration_ms,
        duration_s: seconds(probe.duration_ms),
        width: probe.width,
        height: probe.height,
        container: probe.container,
        frame_count: probe.frame_count,
        media_kind: probe.media_kind,
        size_bytes: probe.size_bytes,
        tracks: probe.tracks,
        first_frames: probe.frame_timeline?.slice(0, 6).map((f) => ({ pts_ms: f.ptsMs, duration_ms: f.durationMs })) ?? null,
        bilibili: result.bilibili ?? null,
        warnings: probe.warnings,
        note: '探测成功只说明"能读到媒体信息"，不等于已经看过画面；看画面请调 video_frames。',
      });
    }

    case 'video_bilibili': {
      if (!a.target) return fail('missing_argument', '需要 target（B 站链接或 BV 号）');
      const resolved = await svc.resolveBilibili(String(a.target), { page: Number.isFinite(a.page) ? Number(a.page) : undefined });
      const payload = {
        ok: resolved.ok,
        access_status: resolved.access_status,
        error: resolved.error,
        metadata: resolved.metadata,
        has_media: resolved.has_media,
        subtitles: resolved.subtitles,
        warnings: resolved.warnings,
        note: resolved.note,
      };
      if (resolved.ok && a.fetch_subtitle === true && resolved.subtitles?.length > 0) {
        const wanted = a.subtitle_lan
          ? resolved.subtitles.find((item) => item.lan === a.subtitle_lan)
          : resolved.subtitles[0];
        if (wanted?.url) {
          const cues = await svc.subtitleCues(wanted.url);
          payload.subtitle = cues.ok
            ? { lan: wanted.lan, cue_count: cues.cues.length, cues: cues.cues.slice(0, 400) }
            : { error: cues.error };
          if (cues.ok && cues.cues.length > 400) payload.subtitle.truncated = true;
        }
      }
      if (!resolved.ok && resolved.access_status === 'METADATA_ONLY') {
        payload.warning_for_model = '只有元数据：绝对不要根据标题/简介描述视频画面上发生了什么。';
      }
      return ok(payload);
    }

    case 'video_frames': {
      // 复用已抽好的帧
      if (a.task_id) {
        const timeline = svc.timeline(String(a.task_id));
        if (!timeline.ok) return fail(timeline.error ?? 'not_found', timeline.message ?? '任务不存在');
        const available = svc.frameContents(String(a.task_id), { maxFrames: a.count ? Number(a.count) : undefined });
        if (available.length === 0) {
          return fail('frames_unavailable', '该任务没有可用的帧文件（可能已被清理），请重新抽帧', { task_id: a.task_id });
        }
        const text = [
          `任务 ${a.task_id}｜复用已抽好的 ${available.length} 帧（未重新抽帧，未额外花 token）`,
          timeline.frames.map((frame, index) => `${index + 1}. t=${formatSeconds(frame.timestamp_ms)}s frame_id=${frame.frame_id}`).join('\n'),
        ].join('\n');
        return buildFrameResponse(text, available);
      }

      if (!a.source_path && !a.source_url && !a.source_bilibili) {
        return fail('missing_argument', '需要 source_path / source_url / source_bilibili（或 task_id 复用已抽帧）');
      }
      const result = await svc.analyze({
        source_path: a.source_path,
        source_url: a.source_url,
        source_bilibili: a.source_bilibili,
        mode: a.mode,
        count: a.count,
        start_ms: a.start_ms,
        end_ms: a.end_ms,
        quality: a.quality,
      });
      if (!result.ok) {
        return fail('analyze_failed', result.error ?? '抽帧失败', {
          task_id: result.task_id,
          access_status: result.access_status,
          bilibili: result.bilibili ?? null,
          warnings: result.warnings,
        });
      }
      const available = svc.frameContents(result.task_id);
      return buildFrameResponse(formatAnalyzeText(result), available, result);
    }

    case 'video_save_events': {
      if (!a.task_id) return fail('missing_argument', '需要 task_id');
      const result = svc.saveEvents(String(a.task_id), a.events, { note: a.note });
      if (!result.ok) {
        return fail(result.error ?? 'invalid_events', '事件未通过校验', {
          issues: result.issues ?? null,
          warnings: result.warnings ?? null,
          tokens: result.timeline_tokens ?? null,
        });
      }
      return ok({
        ok: true,
        task_id: result.task_id,
        saved: result.saved,
        format: result.format,
        timeline_tokens: result.timeline_tokens,
        worth_memory_count: result.worth_memory_count,
        event_ids: result.event_ids,
        warnings: result.warnings,
        hint: result.hint,
      });
    }

    case 'video_query_events': {
      const kinds = ['motion', 'state', 'appear', 'disappear', 'transform', 'scene_change'];
      if (a.kind && !kinds.includes(String(a.kind))) {
        return fail('invalid_argument', `kind 必须是 ${kinds.join('/')} 之一`);
      }
      const result = svc.queryEvents({
        taskId: a.task_id ? String(a.task_id) : undefined,
        fromMs: Number.isFinite(a.from_ms) ? Number(a.from_ms) : undefined,
        toMs: Number.isFinite(a.to_ms) ? Number(a.to_ms) : undefined,
        kind: a.kind ? String(a.kind) : undefined,
        worthMemory: a.worth_memory === true,
        limit: a.limit,
      });
      return ok({
        ok: true,
        count: result.events.length,
        events: result.events,
        note: '这些是已落库的结构化事件；不重新抽帧、不花 token。',
      });
    }

    case 'video_timeline': {
      if (!a.task_id) return fail('missing_argument', '需要 task_id');
      const result = svc.timeline(String(a.task_id));
      if (!result.ok) return fail(result.error ?? 'not_found', result.message ?? '任务不存在');
      return ok({
        ok: true,
        task_id: a.task_id,
        access_status: result.task.access_status,
        duration_ms: result.task.duration_ms,
        coverage: result.coverage,
        frames: result.frames,
        events: result.events,
      });
    }

    case 'video_remember': {
      if (!a.task_id) return fail('missing_argument', '需要 task_id');
      const timeline = svc.timeline(String(a.task_id));
      if (!timeline.ok) return fail(timeline.error ?? 'not_found', timeline.message ?? '任务不存在');
      const remembered = await rememberVideo({
        task: timeline.task,
        events: timeline.events,
        summary: a.summary ? String(a.summary) : null,
        force: a.force === true,
        scope: a.scope ? String(a.scope) : undefined,
        memoryService: svc.memoryService ?? null,
      });
      if (!remembered.ok) {
        return fail(remembered.error ?? 'remember_failed', remembered.message ?? '写入长期记忆失败', {
          hint: remembered.hint ?? '视频能力不受影响；记忆插件未安装/停用时该工具不可用',
        });
      }
      return ok(remembered);
    }

    case 'video_stats': {
      const days = Number.isFinite(a.since_days) ? Number(a.since_days) : null;
      const sinceIso = days && days > 0 ? new Date(Date.now() - days * 86400000).toISOString() : null;
      return ok({ ok: true, ...svc.stats({ sinceIso }), recent: svc.recentTasks(5) });
    }

    case 'video_doctor': {
      const health = svc.health();
      const versions = await svc.toolVersions();
      return ok({
        ok: health.ok,
        plugin_version: health.pluginVersion,
        ffmpeg: versions.ffmpeg ?? null,
        ffprobe: versions.ffprobe ?? null,
        ffmpeg_command: health.tools_resolved?.ffmpeg ?? null,
        database: { path: health.databasePath, schema: health.schemaVersion, integrity: health.integrity, counts: health.counts },
        limits: {
          max_frames: svc.cfg.limits.maxFrames,
          default_frames: svc.cfg.limits.defaultFrames,
          max_duration_s: svc.cfg.limits.maxDurationSec,
          max_bytes: svc.cfg.limits.maxBytes,
          max_image_tokens: svc.cfg.cost.maxImageTokens,
          scene_detect: svc.cfg.sampling.sceneDetect,
        },
        tokens_per_frame: {
          overview: estimateImageTokens(725, 408),
          detail_1080p: estimateImageTokens(1920, 1080),
        },
      });
    }

    default:
      return fail('unknown_tool', `未知工具：${toolName}`);
  }
}

function buildFrameResponse(text, available, result = null) {
  const content = [{ type: 'text', text }];
  const missing = result ? result.frames.length - available.length : 0;
  if (missing > 0) {
    content.push({ type: 'text', text: `（有 ${missing} 帧文件缺失，未附上）` });
  }
  for (const item of available) {
    try {
      const data = fs.readFileSync(item.path).toString('base64');
      content.push({ type: 'image', data, mimeType: 'image/jpeg' });
    } catch (error) {
      log.warn('读取帧文件失败', { frame: item.frame.frame_id, message: String(error?.message ?? error) });
    }
  }
  return { content };
}

/** 把 JSON-Schema 子集翻译成 zod raw shape（z 由宿主传入，避免本包依赖 zod）。 */
export function buildZodShape(spec, z) {
  const shape = {};
  const required = new Set(spec.inputSchema.required ?? []);
  for (const [key, field] of Object.entries(spec.inputSchema.properties ?? {})) {
    let schema;
    if (field.enum) schema = z.enum(field.enum);
    else if (field.type === 'number' || field.type === 'integer') schema = z.number();
    else if (field.type === 'boolean') schema = z.boolean();
    else if (field.type === 'array') schema = z.array(field.items?.type === 'object' ? z.record(z.any()) : z.string());
    else schema = z.string();
    if (field.description) schema = schema.describe(field.description);
    shape[key] = required.has(key) ? schema : schema.optional();
  }
  return shape;
}

/**
 * 注册到宿主的 MCP server。
 * @param {object} server - McpServer（需有 .tool(name, description, shape, handler)）
 * @param {{ z: object, service?: object, prefix?: string }} options
 */
export function registerVideoTools(server, options = {}) {
  const { z, service = null, memoryService = null, prefix = '' } = options;
  if (!z) throw new Error('registerVideoTools 需要宿主传入 zod（options.z）');
  const registered = [];
  const failed = [];
  try {
    const svc = getVideoService(service ? { config: service.cfg, databasePath: service.databasePath, baseDir: service.baseDir } : {});
    if (memoryService) svc.memoryService = memoryService;
  } catch (error) {
    return { registered: [], failed: [{ name: '*', message: String(error?.message ?? error) }] };
  }
  for (const spec of videoToolSpecs) {
    const toolName = `${prefix}${spec.name}`;
    try {
      server.tool(toolName, spec.description, buildZodShape(spec, z), async (args) => invokeVideoTool(spec.name, args, service));
      registered.push(toolName);
    } catch (error) {
      failed.push({ name: toolName, message: String(error?.message ?? error) });
    }
  }
  return { registered, failed };
}

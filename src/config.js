/**
 * 视频理解插件的配置与硬上限。
 *
 * 设计原则：所有会花钱、会吃资源的参数都必须有上限，而且能在配置里改。
 * 非法值启动即报错（与锚点记忆插件保持一致）。
 */

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,

  // 工具定位：留空则用 PATH 查找；显式路径优先（避免 PATH 里是别的 ffmpeg 构建）
  ffmpegPath: '',
  ffprobePath: '',

  // 工作目录（帧临时文件、缓存库）相对插件根目录
  workDir: 'data',
  tempRetentionMinutes: 120,

  limits: {
    /** 单文件/单媒体最大字节数 */
    maxBytes: 500 * 1024 * 1024,
    /** 最大时长（秒）；GIF 也适用 */
    maxDurationSec: 1800,
    /** 单次抽帧最多帧数（成本闸门） */
    maxFrames: 16,
    /** 概览模式默认帧数 */
    defaultFrames: 6,
    /**
     * 宽度硬上限（0 = 不限制）。注意：提供方会把小于 544×544 的图放大到该下限再计费，
     * 所以"缩得更小"省不到钱；概览模式改用"像素数压到下限附近"的策略，见 sampling.targetFrameSize。
     */
    frameMaxWidth: 0,
    /** JPEG 质量（2-31，越小越好） */
    jpegQuality: 4,
    /** 单帧最大像素（防超大图把 token 打爆） */
    maxFramePixels: 1920 * 1080,
  },

  timeouts: {
    probeMs: 20000,
    /** 远程流探测/抽帧要留足（B 站 CDN 首包偶尔慢） */
    remoteProbeMs: 45000,
    extractMs: 60000,
    sceneDetectMs: 90000,
  },

  sampling: {
    /** 是否用 ffmpeg 内置 scene 检测补充候选帧 */
    sceneDetect: true,
    /** scene 阈值（0-1，越小越敏感） */
    sceneThreshold: 0.3,
    /** 概览模式下首帧/末帧必取 */
    alwaysIncludeFirstLast: true,
    /** 单个任务最多调用 scene 检测的时长上限（秒），防止超长视频扫全片 */
    sceneDetectMaxDurationSec: 600,
    /** 用户指定时间窗时，前后额外留的上下文（毫秒） */
    focusPaddingMs: 2000,
  },

  /** 分析成本记账口径（只记录，不做判断） */
  cost: {
    /** 是否在结果里附带 token 估算 */
    estimateTokens: true,
    /** 单任务图片 token 预算（超过就减帧，而不是硬发） */
    maxImageTokens: 4000,
  },

  /** 安全：本地文件只允许这些扩展名（按内容嗅探，不只信扩展名） */
  allowedLocalExtensions: ['.gif', '.mp4', '.webm', '.mkv', '.mov', '.avi', '.m4v', '.mp3', '.m4a', '.wav', '.flac'],
});

function fail(message) {
  throw new Error(`video-understanding 配置错误：${message}`);
}

function num(value, where, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${where} 必须是有限数字`);
  if (integer && !Number.isInteger(value)) fail(`${where} 必须是整数`);
  if (value < min || value > max) fail(`${where} 必须在 [${min}, ${max}] 内`);
  return value;
}

function bool(value, where) {
  if (typeof value !== 'boolean') fail(`${where} 必须是布尔值`);
  return value;
}

function str(value, where, { max = 1024, allowEmpty = true } = {}) {
  if (typeof value !== 'string') fail(`${where} 必须是字符串`);
  if (!allowEmpty && value.length === 0) fail(`${where} 不能为空`);
  if (value.length > max) fail(`${where} 长度不能超过 ${max}`);
  return value;
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue;
    const current = base[key];
    if (current && typeof current === 'object' && !Array.isArray(current)) out[key] = deepMerge(current, value);
    else out[key] = value;
  }
  return out;
}

/**
 * 校验并归一化配置。
 * @param {object} [raw]
 */
export function validateConfig(raw = {}) {
  const merged = deepMerge(DEFAULT_CONFIG, raw);
  const cfg = {};
  cfg.enabled = bool(merged.enabled, 'enabled');
  cfg.ffmpegPath = str(merged.ffmpegPath, 'ffmpegPath');
  cfg.ffprobePath = str(merged.ffprobePath, 'ffprobePath');
  cfg.workDir = str(merged.workDir, 'workDir', { allowEmpty: false, max: 512 });
  cfg.tempRetentionMinutes = num(merged.tempRetentionMinutes, 'tempRetentionMinutes', { min: 0, max: 60 * 24 * 30 });

  const l = merged.limits;
  cfg.limits = {
    maxBytes: num(l.maxBytes, 'limits.maxBytes', { min: 1024 }),
    maxDurationSec: num(l.maxDurationSec, 'limits.maxDurationSec', { min: 1 }),
    maxFrames: num(l.maxFrames, 'limits.maxFrames', { min: 1, max: 64, integer: true }),
    defaultFrames: num(l.defaultFrames, 'limits.defaultFrames', { min: 1, max: 64, integer: true }),
    frameMaxWidth: num(l.frameMaxWidth, 'limits.frameMaxWidth', { min: 0, max: 3840, integer: true }),
    jpegQuality: num(l.jpegQuality, 'limits.jpegQuality', { min: 1, max: 31, integer: true }),
    maxFramePixels: num(l.maxFramePixels, 'limits.maxFramePixels', { min: 1000 }),
  };
  if (cfg.limits.defaultFrames > cfg.limits.maxFrames) fail('limits.defaultFrames 不能大于 limits.maxFrames');

  const t = merged.timeouts;
  cfg.timeouts = {
    probeMs: num(t.probeMs, 'timeouts.probeMs', { min: 1000 }),
    remoteProbeMs: num(t.remoteProbeMs, 'timeouts.remoteProbeMs', { min: 1000 }),
    extractMs: num(t.extractMs, 'timeouts.extractMs', { min: 1000 }),
    sceneDetectMs: num(t.sceneDetectMs, 'timeouts.sceneDetectMs', { min: 1000 }),
  };

  const s = merged.sampling;
  cfg.sampling = {
    sceneDetect: bool(s.sceneDetect, 'sampling.sceneDetect'),
    sceneThreshold: num(s.sceneThreshold, 'sampling.sceneThreshold', { min: 0.01, max: 1 }),
    alwaysIncludeFirstLast: bool(s.alwaysIncludeFirstLast, 'sampling.alwaysIncludeFirstLast'),
    sceneDetectMaxDurationSec: num(s.sceneDetectMaxDurationSec, 'sampling.sceneDetectMaxDurationSec', { min: 0 }),
    focusPaddingMs: num(s.focusPaddingMs, 'sampling.focusPaddingMs', { min: 0 }),
  };

  const c = merged.cost;
  cfg.cost = {
    estimateTokens: bool(c.estimateTokens, 'cost.estimateTokens'),
    maxImageTokens: num(c.maxImageTokens, 'cost.maxImageTokens', { min: 0, max: 200000, integer: true }),
  };

  if (!Array.isArray(merged.allowedLocalExtensions)) fail('allowedLocalExtensions 必须是数组');
  cfg.allowedLocalExtensions = merged.allowedLocalExtensions.map((ext, index) => {
    const value = str(ext, `allowedLocalExtensions[${index}]`, { allowEmpty: false, max: 16 }).toLowerCase();
    if (!value.startsWith('.')) fail(`allowedLocalExtensions[${index}] 必须以点开头`);
    return value;
  });

  return cfg;
}

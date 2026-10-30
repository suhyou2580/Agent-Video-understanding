/**
 * ffmpeg / ffprobe 调用封装。
 *
 * 三条硬规则：
 *  1. **永远用 argv 数组，不拼 shell 字符串** —— 用户输入不能变成命令行参数。
 *  2. **永远带超时**，超时直接 kill，不留孤儿进程。
 *  3. **永远限制协议**：本地文件只允许 `file`，远程只允许 `http,https,tcp,tls,crypto`。
 *     这是对"ffmpeg 直接访问远程 URL 会绕过前置 URL 校验"的补偿措施。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { resolveWorkDir } from './paths.js';

const PROTOCOLS_LOCAL = 'file';
const PROTOCOLS_REMOTE = 'http,https,tcp,tls,crypto,httpproxy';

/**
 * 找到 ffmpeg / ffprobe。优先级：配置 > 环境变量 > PATH。
 * @param {object} cfg
 * @returns {{ ffmpeg: string, ffprobe: string, source: string }}
 */
export function resolveTools(cfg) {
  const ffmpeg = cfg.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  const ffprobe = cfg.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';
  let source = 'path';
  if (cfg.ffmpegPath || process.env.FFMPEG_PATH) source = 'config';
  return { ffmpeg, ffprobe, source };
}

/** 版本探测（用于把"分析环境"写进结果，便于日后复现）。 */
export async function toolVersions(cfg) {
  const { ffmpeg, ffprobe } = resolveTools(cfg);
  const out = {};
  for (const [name, bin] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) {
    try {
      const result = await run(bin, ['-hide_banner', '-version'], { timeoutMs: 10000, maxBuffer: 256 * 1024 });
      out[name] = (result.stdout.split('\n')[0] ?? '').trim().slice(0, 160) || null;
    } catch (error) {
      out[name] = null;
      out[`${name}_error`] = String(error?.message ?? error).slice(0, 200);
    }
  }
  return out;
}

/**
 * 执行一个子进程并收集输出。
 * @param {string} bin
 * @param {string[]} args
 * @param {{ timeoutMs?: number, maxBuffer?: number, input?: string }} [options]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, ms: number, timedOut: boolean }>}
 */
export function run(bin, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxBuffer = options.maxBuffer ?? 8 * 1024 * 1024;
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: String(error?.message ?? error), ms: 0, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr, ms: Date.now() - started, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      // 给它一点时间退出，避免 hang 住
      setTimeout(() => finish(null), 500);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxBuffer) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxBuffer) stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      stderr += String(error?.message ?? error);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

/** 把 ffmpeg 的 stderr 压成一行人话（错误里很多噪声）。 */
export function summarizeFailure(result) {
  if (!result) return '未知错误';
  if (result.timedOut) return `处理超时（${result.ms}ms）`;
  const lines = String(result.stderr ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('frame=') && !line.startsWith('size='));
  const last = lines.slice(-3).join(' | ');
  return (last || 'ffmpeg 未给出错误信息').slice(0, 300);
}

/** 本地文件的安全参数：只允许 file 协议。 */
export function localProtocolArgs() {
  return ['-protocol_whitelist', PROTOCOLS_LOCAL];
}

/**
 * 远程 URL 的安全参数：只允许 http 系协议 + IO 超时 + 可选请求头。
 *
 * 为什么需要请求头：B 站 CDN 会校验 Referer/User-Agent，不带会 403。
 * 头只允许这些白名单键，避免把用户自定义头塞进命令行（`-headers` 的值会被 ffmpeg 解析）。
 */
const ALLOWED_HEADER_KEYS = ['referer', 'user-agent', 'origin', 'accept', 'accept-language'];

export function remoteProtocolArgs(rwTimeoutMs = 15000, headers = null) {
  const args = [
    '-protocol_whitelist', PROTOCOLS_REMOTE,
    '-rw_timeout', String(Math.max(1, Math.round(rwTimeoutMs * 1000))),
  ];
  const lines = [];
  for (const [key, value] of Object.entries(headers ?? {})) {
    const lower = key.toLowerCase();
    if (!ALLOWED_HEADER_KEYS.includes(lower)) continue;
    const text = String(value ?? '').replace(/[\r\n]/g, ' ').trim();
    if (text.length === 0) continue;
    lines.push(`${key}: ${text}`);
  }
  if (lines.length > 0) {
    args.push('-headers', `${lines.join('\r\n')}\r\n`);
  }
  return args;
}

/** 目测一个文件是不是媒体（按 magic，不信扩展名）。 */
export function sniffMediaKind(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const ascii = buffer.slice(0, 12).toString('latin1');
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'gif';
  if (ascii.slice(4, 8) === 'ftyp') return 'mp4';
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'mkv';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'webp';
  if (ascii.startsWith('OggS')) return 'ogg';
  if (ascii.startsWith('ID3') || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

/** 清理 URL 里的签名/令牌参数（写库、日志、结果里都不留）。 */
export function scrubUrl(raw) {
  const text = String(raw ?? '');
  try {
    const url = new URL(text);
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (/token|sign|auth|key|cookie|session|expire|deadline|upsig|cdn/i.test(key)) {
        url.searchParams.set(key, '***');
        changed = true;
      }
    }
    return changed ? url.toString() : text;
  } catch {
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  }
}

/** 流式计算文件 sha256（不整文件读进内存）。 */
export async function hashFile(filePath) {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/** 读文件头做嗅探（只读前 16 字节，不把整个文件读进内存）。 */
export async function sniffFile(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(16);
    await handle.read(buffer, 0, 16, 0);
    return sniffMediaKind(buffer);
  } finally {
    await handle.close();
  }
}

/** 人类可读的字节数。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)}${units[unit]}`;
}

/**
 * 临时目录（每次任务一个）。
 * 注意：`cfg.workDir` 可能是绝对路径，必须先经 resolveWorkDir 归一化，
 * 否则 path.join 会把绝对路径当成相对片段拼出一个不存在的嵌套路径。
 */
export function makeTaskDir(cfg, baseDir, taskId) {
  const dir = path.join(resolveWorkDir(cfg, baseDir), 'tmp', taskId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 清理过期临时目录。 */
export function pruneTaskDirs(cfg, baseDir, { now = Date.now() } = {}) {
  const root = path.join(resolveWorkDir(cfg, baseDir), 'tmp');
  if (!fs.existsSync(root)) return { removed: 0 };
  const ttlMs = cfg.tempRetentionMinutes * 60 * 1000;
  let removed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    try {
      const stat = fs.statSync(full);
      if (ttlMs === 0 || now - stat.mtimeMs > ttlMs) {
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      /* 单个目录失败不影响其它 */
    }
  }
  return { removed };
}

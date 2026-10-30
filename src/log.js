/**
 * 最小日志器：分级、可关闭、**不写媒体内容与凭据**。
 * MCP server 的 stdout 是协议通道，所以日志一律走 stderr 或文件。
 */

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const MAX_LOG_BYTES = 4 * 1024 * 1024;

function parseLevel(value) {
  return LEVELS[String(value ?? 'info').toLowerCase()] ?? LEVELS.info;
}

export function createLogger(options = {}) {
  const level = parseLevel(options.level ?? process.env.VIDEO_UNDERSTANDING_LOG_LEVEL);
  const file = options.file ?? process.env.VIDEO_UNDERSTANDING_LOG_FILE ?? null;
  const useStderr = options.stderr !== false;

  function write(lvl, message, meta) {
    if (LEVELS[lvl] > level) return;
    const line = `[${new Date().toISOString()}] ${lvl.toUpperCase()} ${message}${meta ? ` ${safeJson(meta)}` : ''}`;
    if (useStderr) {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        /* ignore */
      }
    }
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
          if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
        } catch {
          /* 文件不存在 */
        }
        fs.appendFileSync(file, `${line}\n`);
      } catch {
        /* 日志失败不影响主流程 */
      }
    }
  }

  return {
    level,
    error: (m, meta) => write('error', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    info: (m, meta) => write('info', m, meta),
    debug: (m, meta) => write('debug', m, meta),
  };
}

function safeJson(value) {
  try {
    if (typeof value !== 'object' || value === null) return String(value).slice(0, 200);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || item === null) continue;
      if (typeof item === 'object') continue;
      out[key] = typeof item === 'string' ? item.slice(0, 120) : item;
    }
    return JSON.stringify(out);
  } catch {
    return '"<unserializable>"';
  }
}

export const logger = createLogger();

/**
 * 路径解析。单独一层，避免 config / db / store 之间互相 import。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 插件根目录（package.json 所在目录）。 */
export const PLUGIN_ROOT = path.resolve(HERE, '..');
export const MIGRATIONS_DIR = path.join(PLUGIN_ROOT, 'migrations');

/** 默认配置文件路径。 */
export const DEFAULT_CONFIG_FILE = path.join(PLUGIN_ROOT, 'config.json');

/** 数据库与临时文件默认落在插件目录下的 data/。 */
export function resolveWorkDir(cfg, baseDir = PLUGIN_ROOT) {
  return path.isAbsolute(cfg.workDir) ? cfg.workDir : path.resolve(baseDir, cfg.workDir);
}

export function resolveDbPath(cfg, baseDir = PLUGIN_ROOT) {
  return path.join(resolveWorkDir(cfg, baseDir), 'video.db');
}

export function resolveTempRoot(cfg, baseDir = PLUGIN_ROOT) {
  return path.join(resolveWorkDir(cfg, baseDir), 'tmp');
}

/**
 * SQLite 访问层（node:sqlite，无原生依赖）。
 *
 * 与锚点记忆插件同一套做法：迁移可重复执行、事务支持嵌套、健康检查报告真实状态。
 */

import fs from 'node:fs';
import path from 'node:path';

import { MIGRATIONS_DIR } from './paths.js';

let sqliteModule = null;
let sqliteLoadError = null;
try {
  sqliteModule = await import('node:sqlite');
} catch (error) {
  sqliteLoadError = error;
}

function loadSqlite() {
  if (!sqliteModule || typeof sqliteModule.DatabaseSync !== 'function') {
    throw new Error(
      '当前 Node 不支持 node:sqlite（需要 Node >= 22.5）。'
      + (sqliteLoadError ? ` 加载失败原因：${sqliteLoadError.message}` : ''),
    );
  }
  return sqliteModule;
}

export function listMigrationFiles(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) throw new Error(`迁移目录不存在：${dir}`);
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d+_[A-Za-z0-9_-]+\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

export function openDatabase(databasePath, options = {}) {
  const isMemory = databasePath === ':memory:';
  if (!isMemory) fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  if (!isMemory) db.exec('PRAGMA journal_mode = WAL');
  return {
    db,
    databasePath,
    isMemory,
    migrationsDir: options.migrationsDir ?? MIGRATIONS_DIR,
    closed: false,
  };
}

function appliedVersions(handle) {
  handle.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  return new Set(handle.db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
}

/** 执行未应用的迁移（幂等）。 */
export function migrate(handle, { dir } = {}) {
  const migrationsDir = dir ?? handle.migrationsDir;
  const files = listMigrationFiles(migrationsDir);
  const done = appliedVersions(handle);
  const applied = [];
  const skipped = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (done.has(version)) {
      skipped.push(version);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    handle.db.exec('BEGIN IMMEDIATE');
    try {
      handle.db.exec(sql);
      handle.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
      handle.db.exec('COMMIT');
      applied.push(version);
    } catch (error) {
      try {
        handle.db.exec('ROLLBACK');
      } catch {
        /* 保留原始错误 */
      }
      throw new Error(`迁移 ${file} 失败：${error.message}`);
    }
  }
  return { applied, skipped };
}

export function schemaVersion(handle) {
  const versions = [...appliedVersions(handle)].sort();
  return versions.at(-1) ?? null;
}

let savepointSeq = 0;

/** 事务（支持嵌套 SAVEPOINT）。 */
export function transaction(handle, fn) {
  const db = handle.db;
  const depth = handle.__txDepth ?? 0;
  const name = `sp_${++savepointSeq}`;
  if (depth === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${name}`);
  handle.__txDepth = depth + 1;
  try {
    const result = fn();
    if (depth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE ${name}`);
    handle.__txDepth = depth;
    return result;
  } catch (error) {
    try {
      if (depth === 0) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO ${name}`);
    } catch {
      /* 保留原始错误 */
    }
    handle.__txDepth = depth;
    throw error;
  }
}

export function health(handle) {
  const out = { ok: true, databasePath: handle.databasePath, schemaVersion: null, errors: [], counts: {} };
  try {
    out.schemaVersion = schemaVersion(handle);
    const integrity = handle.db.prepare('PRAGMA quick_check').get();
    out.integrity = integrity ? Object.values(integrity)[0] : 'unknown';
    if (out.integrity !== 'ok') {
      out.ok = false;
      out.errors.push(`quick_check=${out.integrity}`);
    }
    for (const table of ['media_tasks', 'media_frames', 'media_events', 'analysis_runs']) {
      try {
        out.counts[table] = handle.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
      } catch {
        out.counts[table] = null;
        out.errors.push(`表 ${table} 不可读`);
        out.ok = false;
      }
    }
  } catch (error) {
    out.ok = false;
    out.errors.push(String(error?.message ?? error));
  }
  return out;
}

-- 视频理解插件初始 schema（迁移 001）
--
-- 设计要点：
--  1. 四层分离：任务（media_tasks）→ 帧证据（media_frames）→ 事件（media_events）→ 调用成本（analysis_runs）。
--  2. 事件必须能追溯到帧证据；证据用 JSON 数组存 frame_id（不存图片本身）。
--  3. `observation_or_inference` 与 `uncertainty` 用 CHECK 约束强制，杜绝"把推断写成事实"。
--  4. 成本按次记录（帧数 / 图片 token / 模型 / 提示词版本），供后续统计真实花费。
--  5. 不存 Cookie / Token：source_ref 在写入前已脱敏，这里再做一层 CHECK 不现实，靠代码层保证。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_tasks (
  task_id       TEXT PRIMARY KEY,
  source_type   TEXT NOT NULL,
  source_ref    TEXT NOT NULL,
  access_status TEXT NOT NULL,
  media_hash    TEXT NULL,
  duration_ms   INTEGER NULL,
  width         INTEGER NULL,
  height        INTEGER NULL,
  container     TEXT NULL,
  size_bytes    INTEGER NULL,
  frame_count   INTEGER NULL,
  probe_json    TEXT NULL,
  tools_json    TEXT NULL,
  cache_key     TEXT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CONSTRAINT ck_task_source CHECK (source_type IN ('local_media','remote_url','gif','user_file')),
  CONSTRAINT ck_task_status CHECK (access_status IN (
    'USER_FILE_READY','VIDEO_READY','AUDIO_VIDEO_READY','TRANSCRIPT_READY',
    'METADATA_ONLY','ACCESS_RESTRICTED','ACCESS_FAILED'))
);

CREATE INDEX IF NOT EXISTS ix_tasks_cache ON media_tasks (cache_key);
CREATE INDEX IF NOT EXISTS ix_tasks_created ON media_tasks (created_at);

CREATE TABLE IF NOT EXISTS media_frames (
  frame_id          TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES media_tasks (task_id) ON DELETE CASCADE,
  timestamp_ms      INTEGER NOT NULL,
  duration_ms       INTEGER NULL,
  source_frame_index INTEGER NULL,
  selection_reason  TEXT NOT NULL,
  path              TEXT NULL,
  bytes             INTEGER NULL,
  width             INTEGER NULL,
  height            INTEGER NULL,
  image_tokens      INTEGER NULL,
  created_at        TEXT NOT NULL,
  CONSTRAINT ck_frame_reason CHECK (selection_reason IN ('first','last','uniform','scene_change','focus'))
);

CREATE INDEX IF NOT EXISTS ix_frames_task_time ON media_frames (task_id, timestamp_ms);

CREATE TABLE IF NOT EXISTS media_events (
  event_id                TEXT PRIMARY KEY,
  task_id                 TEXT NOT NULL REFERENCES media_tasks (task_id) ON DELETE CASCADE,
  start_ms                INTEGER NOT NULL,
  end_ms                  INTEGER NULL,
  description             TEXT NOT NULL,
  evidence_frame_ids      TEXT NOT NULL,
  transcript_refs         TEXT NULL,
  observation_or_inference TEXT NOT NULL,
  uncertainty             TEXT NOT NULL,
  confidence              REAL NULL,
  created_at              TEXT NOT NULL,
  CONSTRAINT ck_event_kind CHECK (observation_or_inference IN ('observation','inference')),
  CONSTRAINT ck_event_uncertainty CHECK (uncertainty IN ('low','medium','high')),
  CONSTRAINT ck_event_range CHECK (end_ms IS NULL OR end_ms >= start_ms)
);

CREATE INDEX IF NOT EXISTS ix_events_task_time ON media_events (task_id, start_ms);

CREATE TABLE IF NOT EXISTS analysis_runs (
  run_id         TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  mode           TEXT NOT NULL,
  quality        TEXT NULL,
  frame_count    INTEGER NOT NULL,
  image_tokens   INTEGER NOT NULL,
  plugin_version TEXT NULL,
  model          TEXT NULL,
  prompt_version TEXT NULL,
  note           TEXT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_runs_task ON analysis_runs (task_id, created_at);

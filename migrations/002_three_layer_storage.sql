-- 迁移 002：三层储存（临时分析 / 视频事件 / 锚点记忆）的字段与索引
--
-- 变更点：
--  1. 新增 media_raw_outputs：保存**原始模型输出**与被拒原文（第一层，按保留策略清理）。
--  2. media_events 增加 kind / continuity / actor / worth_memory / tokens，
--     并加 (task_id, start_ms) 与 (kind, start_ms) 索引，支持"按视频ID + 时间范围 + 数据类型"查询。
--  3. 事件证据帧改为**服务端派生**（模型不必输出 frame_id），
--     但保留 evidence_frame_ids 列以兼容显式传入。

CREATE TABLE IF NOT EXISTS media_raw_outputs (
  raw_id      TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- submit | submit_compact | rejected | model_reply
  payload     TEXT NOT NULL,              -- 原始文本/JSON（原样保存，便于复盘）
  tokens      INTEGER NULL,               -- 估算 token，便于看成本
  note        TEXT NULL,
  created_at  TEXT NOT NULL,
  CONSTRAINT ck_raw_kind CHECK (kind IN ('submit','submit_compact','rejected','model_reply'))
);

CREATE INDEX IF NOT EXISTS ix_raw_task_time ON media_raw_outputs (task_id, created_at);

ALTER TABLE media_events ADD COLUMN kind TEXT NULL;
ALTER TABLE media_events ADD COLUMN continuity TEXT NULL;
ALTER TABLE media_events ADD COLUMN actor TEXT NULL;
ALTER TABLE media_events ADD COLUMN worth_memory INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_events ADD COLUMN tokens INTEGER NULL;

CREATE INDEX IF NOT EXISTS ix_events_kind_time ON media_events (kind, start_ms);
CREATE INDEX IF NOT EXISTS ix_events_worth ON media_events (task_id, worth_memory);

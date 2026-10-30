import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { unevenDelayGif } from '../fixtures/make-gif.mjs';
import { createVideoService } from '../../src/service.js';
import { invokeVideoTool } from '../../src/mcp-tools.js';

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdu-3l-'));
  const service = createVideoService({
    baseDir: dir,
    databasePath: path.join(dir, 'video.db'),
    config: { workDir: dir, tempRetentionMinutes: 0 },
  });
  const gif = path.join(dir, 'clip.gif');
  fs.writeFileSync(gif, unevenDelayGif());
  return {
    service,
    dir,
    gif,
    cleanup() {
      try {
        service.close();
      } catch { /* ignore */ }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    },
  };
}

test('第二层：紧凑事件落库后，kind/continuity/actor/worth/tokens 都在，证据帧由服务端派生', async () => {
  const { service, gif, cleanup } = makeService();
  try {
    const analyzed = await service.analyze({ source_path: gif, count: 4 });
    const saved = service.saveEvents(analyzed.task_id, [
      { t: [0, 1000], e: '纯红画面保持不动', k: 'st', m: 0 },
      { t: [1000, 2000], e: '切到蓝色', k: 'sc', m: 0, w: 1 },
    ]);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.format, 'compact');
    assert.ok(saved.timeline_tokens > 0 && saved.timeline_tokens <= 400);
    assert.equal(saved.worth_memory_count, 1);

    const events = service.queryEvents({ taskId: analyzed.task_id }).events;
    assert.equal(events.length, 2);
    const first = events[0];
    assert.equal(first.kind, 'state');
    assert.equal(first.continuity, 'once');
    assert.equal(first.worth_memory, 0);
    assert.ok(first.tokens > 0);
    // 证据帧不是模型给的，是服务端按时间范围派生的
    assert.ok(first.evidence_frame_ids.length >= 1, '必须派生出证据帧');
    assert.equal(events[1].worth_memory, 1);
  } finally {
    cleanup();
  }
});

test('第二层查询：按视频ID + 时间范围 + 数据类型 + 是否值得记忆', async () => {
  const { service, gif, cleanup } = makeService();
  const gif2 = path.join(path.dirname(gif), 'other.gif');
  fs.writeFileSync(gif2, unevenDelayGif());
  try {
    const a = await service.analyze({ source_path: gif, count: 4 });
    service.saveEvents(a.task_id, [
      { t: [0, 1000], e: '红色', k: 'st', m: 0 },
      { t: [1000, 2200], e: '变蓝', k: 'tr', m: 0, w: 1 },
    ]);
    const b = await service.analyze({ source_path: gif2, count: 2 });
    service.saveEvents(b.task_id, [{ t: [0, 500], e: '另一段视频', k: 'st', m: 0 }]);

    // 按视频 ID 隔离
    assert.equal(service.queryEvents({ taskId: a.task_id }).events.length, 2);
    assert.equal(service.queryEvents({ taskId: b.task_id }).events.length, 1);

    // 按时间范围（交集）：[1100,1500] 与 [1000,2200] 相交，但与 [0,1000] 不相交
    const windowed = service.queryEvents({ taskId: a.task_id, fromMs: 1100, toMs: 1500 }).events;
    assert.equal(windowed.length, 1);
    assert.equal(windowed[0].description, '变蓝');

    // 按数据类型
    assert.equal(service.queryEvents({ kind: 'transform' }).events.length, 1);

    // 只要值得记忆的
    const worth = service.queryEvents({ task_id: undefined, worthMemory: true }).events;
    assert.equal(worth.length, 1);
    assert.equal(worth[0].description, '变蓝');
  } finally {
    cleanup();
  }
});

test('第一层：原始模型输出都会被保存（成功与被拒都留）', async () => {
  const { service, gif, cleanup } = makeService();
  try {
    const analyzed = await service.analyze({ source_path: gif, count: 3 });
    // 一次合法提交
    service.saveEvents(analyzed.task_id, [{ t: [0, 500], e: '红', k: 'st' }]);
    // 一次非法提交（缺 e）
    const bad = service.saveEvents(analyzed.task_id, [{ t: [0, 500] }]);
    assert.equal(bad.ok, false);
    assert.ok(bad.raw_id, '被拒的原始输入也要留 raw_id');

    const outputs = service.rawOutputs(analyzed.task_id).outputs;
    const kinds = outputs.map((o) => o.kind);
    assert.ok(kinds.includes('submit_compact'));
    assert.ok(kinds.includes('rejected'));
  } finally {
    cleanup();
  }
});

test('第一层保留策略：pruneTemp 会清掉原始输出与帧目录，但事件仍在', async () => {
  const { service, gif, cleanup } = makeService();
  try {
    const analyzed = await service.analyze({ source_path: gif, count: 3 });
    service.saveEvents(analyzed.task_id, [{ t: [0, 500], e: '红', k: 'st', w: 1 }]);
    const before = service.rawOutputs(analyzed.task_id).outputs;
    assert.ok(before.length >= 1);

    // tempRetentionMinutes=0 → 立即过期
    const pruned = service.pruneTemp();
    assert.ok(pruned.removed_raw_outputs >= 1, JSON.stringify(pruned));

    // 第二层不受影响
    assert.equal(service.queryEvents({ taskId: analyzed.task_id }).events.length, 1);
  } finally {
    cleanup();
  }
});

test('旧的全字段格式仍然可用，并被标注为 legacy', async () => {
  const { service, gif, cleanup } = makeService();
  try {
    const analyzed = await service.analyze({ source_path: gif, count: 3 });
    const frameId = analyzed.frames[0].frame_id;
    const saved = service.saveEvents(analyzed.task_id, [{
      start_ms: 0,
      end_ms: 500,
      description: '纯红',
      evidence_frame_ids: [frameId],
      observation_or_inference: 'observation',
      uncertainty: 'low',
    }]);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.format, 'legacy');
    assert.ok(saved.hint.includes('紧凑格式'), '应提示改用紧凑格式省 token');
  } finally {
    cleanup();
  }
});

test('第三层：没有 w:1 事件时默认不写长期记忆', async () => {
  const { service, gif, dir, cleanup } = makeService();
  try {
    const analyzed = await service.analyze({ source_path: gif, count: 3 });
    service.saveEvents(analyzed.task_id, [{ t: [0, 500], e: '纯红', k: 'st' }]); // 没标 w
    const remembered = await invokeVideoTool('video_remember', { task_id: analyzed.task_id }, service);
    assert.equal(remembered.isError, true);
    const body = JSON.parse(remembered.content[0].text);
    assert.equal(body.error, 'nothing_worth_remembering');
    assert.ok(body.hint.includes('force'));
  } finally {
    cleanup();
  }
});

test('第三层：标了 w:1 才会写入，且只写这一条摘要', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vdu-3l-mem-'));
  const videoDir = path.join(root, 'video');
  const memoryDir = path.join(root, 'anchor-memory');
  fs.mkdirSync(videoDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  const realMemory = path.resolve(import.meta.dirname, '..', '..', '..', 'anchor-memory');
  if (!fs.existsSync(path.join(realMemory, 'src', 'service.js'))) {
    console.log('（跳过）未找到同级 anchor-memory 插件');
    return;
  }
  const { pathToFileURL } = await import('node:url');
  const { createMemoryService } = await import(pathToFileURL(path.join(realMemory, 'src', 'service.js')).href);
  const memoryService = createMemoryService({
    baseDir: memoryDir,
    config: { databasePath: path.join(memoryDir, 'm.db'), defaultScope: 'qq:test' },
  });
  const service = createVideoService({
    baseDir: videoDir,
    databasePath: path.join(videoDir, 'v.db'),
    config: { workDir: videoDir },
  });
  const gif = path.join(root, 'clip.gif');
  fs.writeFileSync(gif, unevenDelayGif());
  try {
    service.memoryService = memoryService;
    const analyzed = await service.analyze({ source_path: gif, count: 4 });
    service.saveEvents(analyzed.task_id, [
      { t: [0, 1000], e: '红色', k: 'st', m: 0 },            // 不写
      { t: [1000, 2000], e: '切到蓝色', k: 'sc', m: 0, w: 1 }, // 写
    ]);
    const response = await invokeVideoTool('video_remember', { task_id: analyzed.task_id }, service);
    assert.equal(response.isError, undefined, response.content[0].text);
    const body = JSON.parse(response.content[0].text);
    assert.equal(body.ok, true);
    assert.match(body.node_id, /^M_/);
    // 记忆里只该有 w:1 的那条，不该有"红色"
    assert.ok(body.written_text.includes('切到蓝色'));
    assert.ok(!body.written_text.includes('红色'));
    // 记忆只写一条
    assert.equal(memoryService.list({}, { scope: 'qq:test' }).total, 1);
  } finally {
    try { service.close(); } catch { /* ignore */ }
    try { memoryService.close(); } catch { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('MCP：video_save_events 返回 token 用量，video_query_events 可按条件查', async () => {
  const { service, gif, cleanup } = makeService();
  try {
    const framesResponse = await invokeVideoTool('video_frames', { source_path: gif, count: 4 }, service);
    const taskId = framesResponse.content[0].text.match(/任务 (\S+?)｜/)[1];

    const saved = await invokeVideoTool('video_save_events', {
      task_id: taskId,
      events: [
        { t: [0, 1000], e: '红', k: 'st', m: 0 },
        { t: [1000, 2000], e: '变蓝', k: 'tr', m: 0, w: 1 },
      ],
    }, service);
    assert.equal(saved.isError, undefined, saved.content[0].text);
    const savedBody = JSON.parse(saved.content[0].text);
    assert.equal(savedBody.format, 'compact');
    assert.ok(savedBody.timeline_tokens <= 400);
    assert.equal(savedBody.worth_memory_count, 1);

    const queried = await invokeVideoTool('video_query_events', { task_id: taskId, kind: 'transform' }, service);
    const qBody = JSON.parse(queried.content[0].text);
    assert.equal(qBody.ok, true);
    assert.equal(qBody.count, 1);
    assert.equal(qBody.events[0].description, '变蓝');
    assert.ok(qBody.events[0].evidence_frame_ids.length >= 1);

    const badKind = await invokeVideoTool('video_query_events', { kind: 'nope' }, service);
    assert.equal(badKind.isError, true);
  } finally {
    cleanup();
  }
});

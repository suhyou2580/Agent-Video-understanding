import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { unevenDelayGif } from '../fixtures/make-gif.mjs';
import { createVideoService } from '../../src/service.js';
import { invokeVideoTool } from '../../src/mcp-tools.js';
import { rememberVideo, resolveMemory, resetMemoryCache } from '../../src/memory-bridge.js';

/** 目录布局：<tmp>/video 与 <tmp>/anchor-memory（模拟真实同级布局）。 */
async function makePair() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vdu-mem-'));
  const videoDir = path.join(root, 'video');
  const memoryDir = path.join(root, 'anchor-memory');
  fs.mkdirSync(videoDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });

  // 复用真实的锚点记忆插件源码（只把 baseDir/库路径指到临时目录）
  const realMemory = path.resolve(import.meta.dirname, '..', '..', '..', 'anchor-memory');
  if (!fs.existsSync(path.join(realMemory, 'src', 'service.js'))) {
    return { skip: '未找到同级 anchor-memory 插件，跳过跨插件测试' };
  }
  const { createMemoryService } = await import(pathToFileURL(path.join(realMemory, 'src', 'service.js')).href);
  const memoryService = createMemoryService({
    baseDir: memoryDir,
    config: { databasePath: path.join(memoryDir, 'memory.db'), defaultScope: 'qq:test' },
  });

  const videoService = createVideoService({
    baseDir: videoDir,
    databasePath: path.join(videoDir, 'video.db'),
    config: { workDir: videoDir },
  });
  const gif = path.join(root, 'clip.gif');
  fs.writeFileSync(gif, unevenDelayGif());

  return {
    root,
    videoService,
    memoryService,
    gif,
    cleanup() {
      try {
        videoService.close();
      } catch { /* ignore */ }
      try {
        memoryService.close();
      } catch { /* ignore */ }
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch { /* ignore */ }
    },
  };
}

test('video_remember：把观察写成一条记忆，推断不写入', async () => {
  const pair = await makePair();
  if (pair.skip) {
    console.log(pair.skip);
    return;
  }
  try {
    const analyzed = await pair.videoService.analyze({ source_path: pair.gif, count: 4 });
    assert.equal(analyzed.ok, true, analyzed.error ?? '');
    // 用紧凑格式：观察事件标 w:1（值得记），推断事件标 x:1（不该写进长期记忆）
    pair.videoService.saveEvents(analyzed.task_id, [
      { t: [0, 1000], e: '画面是纯红色', k: 'st', m: 0, w: 1 },
      { t: [2000, 2200], e: '我猜他想表达结束', k: 'st', m: 0, x: 1 },
    ]);

    const timeline = pair.videoService.timeline(analyzed.task_id);
    const remembered = await rememberVideo({
      task: timeline.task,
      events: timeline.events,
      memoryService: pair.memoryService,
    });
    assert.equal(remembered.ok, true, JSON.stringify(remembered));
    assert.match(remembered.node_id, /^M_/);
    // 只写观察，不写推断
    assert.ok(remembered.written_text.includes('画面是纯红色'));
    assert.ok(!remembered.written_text.includes('我猜他想表达结束'));
    assert.ok(remembered.written_text.includes('另有 1 条推断'));

    // 记忆库里能召回这条
    const recalled = pair.memoryService.recall('视频 红色', { scope: 'qq:test' });
    assert.ok(recalled.memories.some((m) => m.node_id === remembered.node_id));
    const node = pair.memoryService.detail(remembered.node_id).memory;
    assert.equal(node.source_type, 'imported');
    assert.equal(node.memory_type, 'event');
    assert.equal(node.payload.object, 'clip.gif');
  } finally {
    pair.cleanup();
  }
});

test('video_remember：重复调用被记忆库去重，不会灌满长期记忆', async () => {
  const pair = await makePair();
  if (pair.skip) {
    console.log(pair.skip);
    return;
  }
  try {
    const analyzed = await pair.videoService.analyze({ source_path: pair.gif, count: 2 });
    const timeline = pair.videoService.timeline(analyzed.task_id);
    pair.videoService.saveEvents(analyzed.task_id, [
      { t: [0], e: '纯红画面', k: 'st', m: 0, w: 1 },
    ]);
    const second = pair.videoService.timeline(analyzed.task_id);

    const first = await rememberVideo({ task: timeline.task, events: second.events, memoryService: pair.memoryService });
    const again = await rememberVideo({ task: timeline.task, events: second.events, memoryService: pair.memoryService });
    assert.equal(first.ok, true);
    assert.equal(again.ok, true);
    assert.equal(again.node_id, first.node_id, '同一内容应去重到同一节点');
    assert.equal(pair.memoryService.list({}, { scope: 'qq:test' }).total, 1);
  } finally {
    pair.cleanup();
  }
});

test('video_remember 通过 MCP 工具调用返回 node_id', async () => {
  const pair = await makePair();
  if (pair.skip) {
    console.log(pair.skip);
    return;
  }
  try {
    pair.videoService.memoryService = pair.memoryService;
    const response = await invokeVideoTool('video_frames', { source_path: pair.gif, count: 3 }, pair.videoService);
    const text = response.content[0].text;
    const taskId = text.match(/任务 (\S+?)｜/)?.[1];
    assert.ok(taskId, '应能从返回文本里取到 task_id');
    pair.videoService.saveEvents(taskId, [
      { t: [0], e: '红画面', k: 'st', m: 0, w: 1 },
    ]);

    const remembered = await invokeVideoTool('video_remember', { task_id: taskId }, pair.videoService);
    assert.equal(remembered.isError, undefined, remembered.content[0].text);
    const body = JSON.parse(remembered.content[0].text);
    assert.equal(body.ok, true);
    assert.match(body.node_id, /^M_/);
  } finally {
    pair.cleanup();
  }
});

test('记忆服务缺失时：video_remember 报 memory_unavailable，视频工具不受影响', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdu-nomem-'));
  const videoService = createVideoService({
    baseDir: dir,
    databasePath: path.join(dir, 'video.db'),
    config: { workDir: dir },
  });
  const gif = path.join(dir, 'clip.gif');
  fs.writeFileSync(gif, unevenDelayGif());
  resetMemoryCache();
  try {
    const analyzed = await videoService.analyze({ source_path: gif, count: 2 });
    assert.equal(analyzed.ok, true);
    const timeline = videoService.timeline(analyzed.task_id);
    // dirs: [] 明确不给任何候选 ⇒ 模拟"没装记忆插件"
    const missing = await rememberVideo({ task: timeline.task, events: [], dirs: [] });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'memory_unavailable');

    // 视频能力本身仍然可用
    const frames = await invokeVideoTool('video_frames', { task_id: analyzed.task_id }, videoService);
    assert.equal(frames.isError, undefined);
  } finally {
    videoService.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
});

test('resolveMemory 在找不到插件时给出可操作提示', async () => {
  resetMemoryCache();
  const result = await resolveMemory({ dirs: [path.join(os.tmpdir(), 'definitely-no-memory-plugin')] });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /记忆插件|anchor-memory/);
});

test('resolveMemory 默认能按同级目录找到锚点记忆插件', async () => {
  resetMemoryCache();
  const result = await resolveMemory();
  if (!result.ok) {
    console.log(`（跳过）未安装 anchor-memory：${result.error}`);
    return;
  }
  assert.equal(result.ok, true);
  assert.ok(result.service, '应返回可用的记忆服务');
  assert.equal(typeof result.service.writeStructured, 'function', '记忆插件必须提供结构化写入接口');
  resetMemoryCache();
});

test('记忆插件不可用时 video_remember 报错而不是伪造成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdu-nomem2-'));
  const videoService = createVideoService({
    baseDir: dir,
    databasePath: path.join(dir, 'video.db'),
    config: { workDir: dir },
  });
  const gif = path.join(dir, 'clip.gif');
  fs.writeFileSync(gif, unevenDelayGif());
  try {
    const analyzed = await videoService.analyze({ source_path: gif, count: 2 });
    const timeline = videoService.timeline(analyzed.task_id);
    // 直接用一个不存在的记忆服务对象模拟"插件缺失/不可用"
    const broken = {
      cfg: { enabled: true },
      writeStructured() {
        return { ok: false, error: 'write_failed', message: '模拟写入失败' };
      },
    };
    // force:true 跳过"必须标 w:1"的过滤，专门验证写入失败会被如实上报
    const result = await rememberVideo({ task: timeline.task, events: [], force: true, memoryService: broken });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'memory_write_failed');
  } finally {
    videoService.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
});

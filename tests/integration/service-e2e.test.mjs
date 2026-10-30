import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { unevenDelayGif, buildGif } from '../fixtures/make-gif.mjs';
import { createVideoService } from '../../src/service.js';
import { invokeVideoTool, videoToolSpecs } from '../../src/mcp-tools.js';

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdu-svc-'));
  const service = createVideoService({
    baseDir: dir,
    databasePath: path.join(dir, 'video.db'),
    config: { workDir: dir },
  });
  return {
    service,
    dir,
    cleanup() {
      try {
        service.close();
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows 句柄 */
      }
    },
  };
}

test('端到端：GIF → 探测 → 抽帧 → 落库 → 事件 → 回读', async () => {
  const { service, dir, cleanup } = makeService();
  const gif = path.join(dir, 'clip.gif');
  fs.writeFileSync(gif, unevenDelayGif());
  try {
    const result = await service.analyze({ source_path: gif, count: 4 });
    assert.equal(result.ok, true, result.error ?? '');
    assert.equal(result.access_status, 'USER_FILE_READY');
    assert.equal(result.frames.length, 4);
    assert.deepEqual(result.frames.map((f) => f.timestamp_ms), [0, 1000, 1300, 2000]);
    assert.equal(result.cached, false);
    assert.ok(result.cost.image_tokens_total > 0);
    // 帧文件真实存在
    for (const frame of result.frames) assert.ok(fs.existsSync(frame.path));

    // 事件：先给一条没有证据的，必须被拒
    const bad = service.saveEvents(result.task_id, [{
      start_ms: 0,
      description: '一个人在跳舞',
      observation_or_inference: 'observation',
      uncertainty: 'medium',
    }]);
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'invalid_events');

    // 再给一条合法事件
    const frameId = result.frames[0].frame_id;
    const good = service.saveEvents(result.task_id, [{
      start_ms: 0,
      end_ms: 1000,
      description: '画面以红色纯色为主',
      evidence_frame_ids: [frameId],
      observation_or_inference: 'observation',
      uncertainty: 'low',
    }]);
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(good.saved, 1);

    const timeline = service.timeline(result.task_id);
    assert.equal(timeline.ok, true);
    assert.equal(timeline.events.length, 1);
    assert.equal(timeline.events[0].description, '画面以红色纯色为主');
    assert.deepEqual(timeline.events[0].evidence_frame_ids, [frameId]);
    assert.equal(timeline.frames.length, 4);
  } finally {
    cleanup();
  }
});

test('缓存：同媒体同参数第二次不重新抽帧', async () => {
  const { service, dir, cleanup } = makeService();
  const gif = path.join(dir, 'clip.gif');
  fs.writeFileSync(gif, unevenDelayGif());
  try {
    const first = await service.analyze({ source_path: gif, count: 4 });
    const second = await service.analyze({ source_path: gif, count: 4 });
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.task_id, first.task_id);
    assert.ok(second.warnings.some((w) => w.includes('缓存')));

    // 改了帧数就必须重算（缓存键包含采样参数）
    const different = await service.analyze({ source_path: gif, count: 2 });
    assert.equal(different.cached, false);
    assert.notEqual(different.task_id, first.task_id);
  } finally {
    cleanup();
  }
});

test('成本统计：看过多少帧、多少图片 token、缓存命中、失败率', async () => {
  const { service, dir, cleanup } = makeService();
  const gif = path.join(dir, 'clip.gif');
  fs.writeFileSync(gif, unevenDelayGif());
  const broken = path.join(dir, 'broken.mp4');
  fs.writeFileSync(broken, Buffer.from('not a video'));
  try {
    await service.analyze({ source_path: gif, count: 4 });
    await service.analyze({ source_path: gif, count: 4 }); // 缓存命中
    await service.analyze({ source_path: broken }); // 失败任务

    const stats = service.stats();
    assert.equal(stats.tasks_total, 2, '失败任务也会记一条 task');
    assert.equal(stats.tasks_failed, 1);
    assert.ok(stats.frames_seen >= 4);
    assert.ok(stats.image_tokens_total > 0);
    assert.ok(stats.image_tokens_avg > 0);
    assert.ok(stats.cache_hits >= 1);
    assert.ok(stats.failure_rate > 0 && stats.failure_rate <= 1);
    assert.equal(stats.by_status.ACCESS_FAILED, 1);
  } finally {
    cleanup();
  }
});

test('删除任务：帧/事件/临时文件一起清掉', async () => {
  const { service, dir, cleanup } = makeService();
  const gif = path.join(dir, 'clip.gif');
  fs.writeFileSync(gif, unevenDelayGif());
  try {
    const result = await service.analyze({ source_path: gif, count: 2 });
    const frameDir = path.dirname(result.frames[0].path);
    assert.ok(fs.existsSync(frameDir));
    const removed = service.deleteTask(result.task_id);
    assert.equal(removed.ok, true);
    assert.ok(removed.frames >= 1);
    assert.equal(service.timeline(result.task_id).ok, false);
    assert.equal(fs.existsSync(frameDir), false);
  } finally {
    cleanup();
  }
});

test('MCP 工具：video_frames 返回文字说明 + 图片内容块（顺序与文字一致）', async () => {
  const { service, dir, cleanup } = makeService();
  const gif = path.join(dir, 'clip.gif');
  fs.writeFileSync(gif, unevenDelayGif());
  try {
    const response = await invokeVideoTool('video_frames', { source_path: gif, count: 4 }, service);
    assert.equal(response.isError, undefined, JSON.stringify(response.content?.[0]));
    const images = response.content.filter((block) => block.type === 'image');
    assert.equal(images.length, 4, '应附上 4 张图');
    for (const image of images) {
      assert.equal(image.mimeType, 'image/jpeg');
      assert.ok(image.data.length > 100);
      // base64 → JPEG magic
      const bytes = Buffer.from(image.data, 'base64');
      assert.equal(bytes[0], 0xff);
      assert.equal(bytes[1], 0xd8);
    }
    const text = response.content[0].text;
    assert.ok(text.includes('t=1.00s'));
    assert.ok(text.includes('t=1.30s'));
    assert.ok(text.includes('采样帧'), '必须提醒这是采样帧');
  } finally {
    cleanup();
  }
});

test('MCP 工具：传 task_id 复用已抽好的帧，不重新抽帧', async () => {
  const { service, dir, cleanup } = makeService();
  const gif = path.join(dir, 'clip.gif');
  fs.writeFileSync(gif, unevenDelayGif());
  try {
    const first = await invokeVideoTool('video_frames', { source_path: gif, count: 4 }, service);
    const taskId = JSON.parse(first.content[0].text.match(/任务 (\S+?)｜/)[1] ? `"${first.content[0].text.match(/任务 (\S+?)｜/)[1]}"` : 'null');
    const before = service.stats().runs;
    const reused = await invokeVideoTool('video_frames', { task_id: taskId }, service);
    assert.equal(reused.isError, undefined);
    assert.ok(reused.content.filter((b) => b.type === 'image').length === 4);
    assert.ok(reused.content[0].text.includes('复用'));
    assert.equal(service.stats().runs, before, '复用不应产生新的 analysis_run');
  } finally {
    cleanup();
  }
});

test('MCP 工具：video_probe / video_timeline / video_stats / video_doctor 可用', async () => {
  const { service, dir, cleanup } = makeService();
  const gif = path.join(dir, 'clip.gif');
  fs.writeFileSync(gif, unevenDelayGif());
  try {
    const probeResponse = await invokeVideoTool('video_probe', { source_path: gif }, service);
    const probe = JSON.parse(probeResponse.content[0].text);
    assert.equal(probe.ok, true);
    assert.equal(probe.frame_count, 4);
    assert.ok(probe.first_frames.length >= 4);
    assert.ok(probe.note.includes('不等于已经看过画面'));

    const analyzed = await service.analyze({ source_path: gif, count: 4 });
    service.saveEvents(analyzed.task_id, [{
      start_ms: 0, description: '红色画面', evidence_frame_ids: [analyzed.frames[0].frame_id],
      observation_or_inference: 'observation', uncertainty: 'low',
    }]);
    const timeline = JSON.parse((await invokeVideoTool('video_timeline', { task_id: analyzed.task_id }, service)).content[0].text);
    assert.equal(timeline.ok, true);
    assert.equal(timeline.events.length, 1);

    const stats = JSON.parse((await invokeVideoTool('video_stats', {}, service)).content[0].text);
    assert.equal(stats.ok, true);
    assert.ok(stats.recent.length >= 1);

    const doctor = JSON.parse((await invokeVideoTool('video_doctor', {}, service)).content[0].text);
    assert.equal(doctor.ok, true);
    assert.match(doctor.ffmpeg, /ffmpeg version/i);
    assert.ok(doctor.tokens_per_frame.overview > 0);
  } finally {
    cleanup();
  }
});

test('MCP 工具：缺参数与不存在的任务返回结构化错误', async () => {
  const { service, cleanup } = makeService();
  try {
    const missing = await invokeVideoTool('video_frames', {}, service);
    assert.equal(missing.isError, true);
    assert.equal(JSON.parse(missing.content[0].text).error, 'missing_argument');

    const missingTask = await invokeVideoTool('video_frames', { task_id: 'V_nope' }, service);
    assert.equal(missingTask.isError, true);

    const unknown = await invokeVideoTool('video_nope', {}, service);
    assert.equal(JSON.parse(unknown.content[0].text).error, 'unknown_tool');
  } finally {
    cleanup();
  }
});

test('MCP 工具规格完整（每个工具都有描述与 schema）', () => {
  const names = videoToolSpecs.map((spec) => spec.name);
  for (const required of ['video_probe', 'video_frames', 'video_save_events', 'video_timeline', 'video_stats', 'video_doctor']) {
    assert.ok(names.includes(required), `缺少工具 ${required}`);
  }
  for (const spec of videoToolSpecs) {
    assert.ok(spec.description.length > 20, `${spec.name} 描述太短`);
    assert.equal(spec.inputSchema.type, 'object');
  }
});

test('非均匀延迟 GIF 的帧时长在端到端结果里保持正确', async () => {
  const { service, dir, cleanup } = makeService();
  // 6 帧，延迟依次 1.0 / 0.2 / 0.3 / 0.4 / 0.5 / 0.6 秒
  const frames = [100, 20, 30, 40, 50, 60].map((delayCs, index) => ({ delayCs, colorIndex: index % 2 }));
  const gif = path.join(dir, 'multi.gif');
  fs.writeFileSync(gif, buildGif({ width: 8, height: 8, colors: [[255, 0, 0], [0, 0, 255]], frames, loop: 0 }));
  try {
    const result = await service.analyze({ source_path: gif, count: 6, mode: 'all' });
    assert.equal(result.ok, true, result.error ?? '');
    const expectedStamps = [0, 1000, 1200, 1500, 1900, 2400];
    assert.deepEqual(result.frames.map((f) => f.timestamp_ms), expectedStamps);
    assert.equal(result.duration_ms, 3000);
  } finally {
    cleanup();
  }
});

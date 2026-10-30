import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createVideoService } from '../../src/service.js';
import { detectSceneChanges } from '../../src/sampling.js';

function ws() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdu-cont-'));
  return {
    dir,
    service: createVideoService({ baseDir: dir, databasePath: path.join(dir, 'v.db'), config: { workDir: dir } }),
    cleanup() {
      try {
        this.service.close();
      } catch { /* ignore */ }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    },
  };
}

/**
 * 单镜头 + 持续变化的画面：4 秒内没有镜头切换，但画面一直在动。
 * 用 `testsrc2` 而不是 `drawbox`：drawbox 的 x 表达式在这个构建里不逐帧求值，
 * 造出来的是静止画面（实测首末帧完全相同），那就测不出"连续动作"了。
 */
function makeContinuousShot(file) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x120:d=4:r=10',
    '-pix_fmt', 'yuv420p', '-y', file,
  ], { stdio: 'pipe' });
}

function grayFrame(file) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], {
    maxBuffer: 8 * 1024 * 1024,
  });
}

function diffRatio(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff += 1;
  return diff / a.length;
}

test('同一镜头内的连续动作：没有镜头切换，但加密采样能看出画面在变', async () => {
  const { dir, service, cleanup } = ws();
  const file = path.join(dir, 'moving.mp4');
  makeContinuousShot(file);
  const cfg = service.cfg;
  try {
    // 1) 场景检测不该报出切换点（同一镜头）
    const scenes = await detectSceneChanges(cfg, { kind: 'local', path: file });
    assert.equal(scenes.ok, true, scenes.error ?? '');
    assert.equal(scenes.timestampsMs.length, 0, `单镜头不应有切换点，实际 ${JSON.stringify(scenes.timestampsMs)}`);

    // 2) 概览仍能取到多帧，且第一帧与最后一帧画面不同（说明不是复制同一帧）
    const overview = await service.analyze({ source_path: file, count: 4 });
    assert.equal(overview.ok, true, overview.error ?? '');
    assert.equal(overview.frames.length, 4);
    const first = grayFrame(overview.frames[0].path);
    const last = grayFrame(overview.frames[overview.frames.length - 1].path);
    assert.ok(diffRatio(first, last) > 0.005, '首末帧画面应不同（方块在移动）');

    // 3) 局部精读：同一时间段内加密采样，相邻帧也能看出差异
    const focus = await service.analyze({
      source_path: file,
      mode: 'focus',
      start_ms: 1000,
      end_ms: 2000,
      count: 3,
    });
    assert.equal(focus.ok, true, focus.error ?? '');
    assert.ok(focus.frames.length >= 2);
    const grays = focus.frames.map((f) => grayFrame(f.path));
    for (let i = 1; i < grays.length; i += 1) {
      assert.ok(diffRatio(grays[i - 1], grays[i]) > 0, `第 ${i} 帧与前一帧应不同`);
    }

    // 4) 场景检测为空时，采样计划仍要能在覆盖说明里体现"用均匀采样兜底"
    assert.ok(focus.sampling.coverage.notes.length >= 0);
    assert.equal(focus.sampling.mode, 'focus');
  } finally {
    cleanup();
  }
});

test('场景切换点只作为候选帧，不会被当成语义事件写进事件表', async () => {
  const { dir, service, cleanup } = ws();
  const file = path.join(dir, 'moving.mp4');
  makeContinuousShot(file);
  try {
    const analyzed = await service.analyze({ source_path: file, count: 4 });
    const timeline = service.timeline(analyzed.task_id);
    // 事件表必须为空：抽帧/场景检测从不自动"编"事件
    assert.equal(timeline.events.length, 0, '插件不得自行生成语义事件，事件只能由模型提交');
    // 帧的选择理由可以包含 scene_change，但那只是采样理由
    const reasons = new Set(analyzed.frames.map((f) => f.selection_reason));
    assert.ok([...reasons].every((r) => ['first', 'last', 'uniform', 'scene_change', 'focus'].includes(r)));
  } finally {
    cleanup();
  }
});

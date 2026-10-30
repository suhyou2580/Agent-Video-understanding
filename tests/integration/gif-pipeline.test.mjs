import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildGif, unevenDelayGif } from '../fixtures/make-gif.mjs';
import { validateConfig } from '../../src/config.js';
import { probe } from '../../src/probe.js';
import { planSampling, detectSceneChanges } from '../../src/sampling.js';
import { extractFrames, describeFrames, nearestFrameIndex } from '../../src/frames.js';
import { toolVersions } from '../../src/media.js';

const cfg = validateConfig({ workDir: '.' });

/** 每个用例一个临时目录。 */
function tempWorkspace(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vdu-${label}-`));
  return {
    dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows 句柄偶尔未释放 */
      }
    },
  };
}

/** 读一帧图片中心像素（用 ffmpeg 解到 rawvideo，避免引入 PNG 解码依赖）。 */
function centerPixel(filePath, width, height) {
  const raw = execFileSync('ffmpeg', [
    '-v', 'error', '-i', filePath, '-frames:v', '1',
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
  ], { maxBuffer: 16 * 1024 * 1024 });
  const index = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 3;
  return [raw[index], raw[index + 1], raw[index + 2]];
}

test('ffmpeg/ffprobe 可用，且版本被记录', async () => {
  const versions = await toolVersions(cfg);
  assert.match(String(versions.ffmpeg), /ffmpeg version \d+/i);
  assert.match(String(versions.ffprobe), /ffprobe version \d+/i);
});

test('探测非均匀延迟 GIF：帧数、逐帧时间轴、总时长都正确', async () => {
  const { dir, cleanup } = tempWorkspace('probe');
  const file = path.join(dir, 'uneven.gif');
  fs.writeFileSync(file, unevenDelayGif());
  try {
    const result = await probe(cfg, { kind: 'local', path: file });
    assert.equal(result.ok, true, result.error ?? '');
    assert.equal(result.access_status, 'USER_FILE_READY');
    assert.equal(result.media_kind, 'gif');
    assert.equal(result.frame_count, 4);
    assert.deepEqual(result.frame_timeline.map((f) => f.ptsMs), [0, 1000, 1300, 2000]);
    assert.deepEqual(result.frame_timeline.map((f) => f.durationMs), [1000, 300, 700, 200]);
    assert.equal(result.duration_ms, 2200);
    assert.equal(result.width, 8);
    assert.equal(result.height, 8);
    // 必须提示"帧延迟不一致"，防止下游按固定帧率推算
    assert.ok(result.warnings.some((w) => w.includes('帧延迟不一致')));
  } finally {
    cleanup();
  }
});

test('抽帧：4 帧全部取出、顺序与颜色正确（红蓝红蓝）', async () => {
  const { dir, cleanup } = tempWorkspace('frames');
  const file = path.join(dir, 'uneven.gif');
  fs.writeFileSync(file, unevenDelayGif());
  const taskDir = path.join(dir, 'task');
  fs.mkdirSync(taskDir, { recursive: true });
  try {
    const probeResult = await probe(cfg, { kind: 'local', path: file });
    const plan = planSampling(cfg, probeResult, { mode: 'overview', count: 4 });
    const extracted = await extractFrames(cfg, { kind: 'local', path: file }, probeResult, plan, { taskDir });

    assert.equal(extracted.ok, true, extracted.error ?? '');
    assert.equal(extracted.method, 'select-by-index');
    // 8x8 的 GIF 只有 4 帧，计划 4 帧应全部命中，且不去重丢掉
    assert.equal(extracted.frames.length, 4);

    const stamps = extracted.frames.map((f) => f.timestamp_ms);
    assert.deepEqual(stamps, [0, 1000, 1300, 2000]);

    const colors = extracted.frames.map((f) => centerPixel(f.path, 8, 8));
    assert.deepEqual(colors.map(([r, g, b]) => (r > 200 && b < 50 ? 'red' : 'blue')), ['red', 'blue', 'red', 'blue']);

    // 每帧都应是真实文件
    for (const frame of extracted.frames) {
      assert.ok(fs.existsSync(frame.path));
      assert.ok(frame.bytes > 0);
    }

    const text = describeFrames(extracted.frames);
    assert.ok(text.includes('t=1.00s'));
    assert.ok(text.includes('t=1.30s'));
  } finally {
    cleanup();
  }
});

test('不只看第一帧：采样点覆盖到末帧', async () => {
  const { dir, cleanup } = tempWorkspace('coverage');
  // 构造 8 帧的 GIF，延迟递增
  const file = path.join(dir, 'many.gif');
  fs.writeFileSync(file, buildGif({
    width: 8,
    height: 8,
    colors: [[255, 0, 0], [0, 0, 255]],
    frames: Array.from({ length: 8 }, (_, i) => ({ delayCs: (i + 1) * 10, colorIndex: i % 2 })),
    loop: 0,
  }));
  const taskDir = path.join(dir, 'task');
  fs.mkdirSync(taskDir, { recursive: true });
  try {
    const probeResult = await probe(cfg, { kind: 'local', path: file });
    assert.equal(probeResult.frame_count, 8);
    const plan = planSampling(cfg, probeResult, { mode: 'overview', count: 4 });
    const extracted = await extractFrames(cfg, { kind: 'local', path: file }, probeResult, plan, { taskDir });

    const stamps = extracted.frames.map((f) => f.timestamp_ms);
    assert.ok(stamps.length >= 3);
    assert.equal(stamps[0], 0, '必须包含首帧');
    assert.equal(
      stamps[stamps.length - 1],
      probeResult.frame_timeline.at(-1).ptsMs,
      '必须包含末帧（不能只分析第一帧）',
    );
    // 首帧像素应为红
    const first = centerPixel(extracted.frames[0].path, 8, 8);
    assert.ok(first[0] > 200 && first[2] < 50);
  } finally {
    cleanup();
  }
});

test('场景切换检测：3 段视频能在切换点附近检出', async () => {
  const { dir, cleanup } = tempWorkspace('scene');
  const file = path.join(dir, 'scenes.mp4');
  try {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=160x120:d=1',
      '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=1',
      '-f', 'lavfi', '-i', 'color=c=green:s=160x120:d=1',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0',
      '-pix_fmt', 'yuv420p', '-y', file,
    ], { stdio: 'pipe' });
    const result = await detectSceneChanges(cfg, { kind: 'local', path: file });
    assert.equal(result.ok, true, result.error ?? '');
    assert.ok(result.timestampsMs.length >= 2, `应检出至少 2 个切换点，实际 ${JSON.stringify(result.timestampsMs)}`);
    // 切换点应在 1s 和 2s 附近（±400ms）
    const near = (target) => result.timestampsMs.some((ts) => Math.abs(ts - target) <= 400);
    assert.ok(near(1000), `缺少 1s 附近的切换点：${JSON.stringify(result.timestampsMs)}`);
    assert.ok(near(2000), `缺少 2s 附近的切换点：${JSON.stringify(result.timestampsMs)}`);
  } finally {
    cleanup();
  }
});

test('探测失败时不伪造结果：损坏文件返回 ACCESS_FAILED', async () => {
  const { dir, cleanup } = tempWorkspace('broken');
  const file = path.join(dir, 'broken.mp4');
  fs.writeFileSync(file, Buffer.from('this is definitely not a video file'));
  try {
    const result = await probe(cfg, { kind: 'local', path: file });
    assert.equal(result.ok, false);
    assert.equal(result.access_status, 'ACCESS_FAILED');
    assert.ok(result.error, '必须给出可理解的错误');
  } finally {
    cleanup();
  }
});

test('不存在的文件返回明确错误而不是抛异常', async () => {
  const result = await probe(cfg, { kind: 'local', path: path.join(os.tmpdir(), 'definitely-missing-xyz.mp4') });
  assert.equal(result.ok, false);
  assert.match(result.error, /不存在|不可读/);
});

test('nearestFrameIndex 在非均匀时间轴上取最近帧', () => {
  const timeline = [
    { index: 0, ptsMs: 0 },
    { index: 1, ptsMs: 1000 },
    { index: 2, ptsMs: 1300 },
  ];
  assert.equal(nearestFrameIndex(timeline, 100).index, 0);
  assert.equal(nearestFrameIndex(timeline, 1100).index, 1);
  assert.equal(nearestFrameIndex(timeline, 1290).index, 2);
});

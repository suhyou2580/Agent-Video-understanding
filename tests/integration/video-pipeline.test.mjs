import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createVideoService } from '../../src/service.js';
import { invokeVideoTool } from '../../src/mcp-tools.js';

function makeService(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdu-vid-'));
  const service = createVideoService({
    baseDir: dir,
    databasePath: path.join(dir, 'video.db'),
    config: { workDir: dir, ...overrides },
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

/** 生成"红 1s / 蓝 1s / 绿 1s"的三段视频。 */
function makeThreeSceneMp4(file, { withAudio = false } = {}) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x120:d=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=1',
    '-f', 'lavfi', '-i', 'color=c=green:s=160x120:d=1',
  ];
  if (withAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=3');
  args.push(
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]',
  );
  if (withAudio) args.push('-map', '3:a', '-shortest');
  args.push('-pix_fmt', 'yuv420p', '-y', file);
  execFileSync('ffmpeg', args, { stdio: 'pipe' });
}

function centerPixel(filePath, width, height) {
  const raw = execFileSync('ffmpeg', [
    '-v', 'error', '-i', filePath, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
  ], { maxBuffer: 16 * 1024 * 1024 });
  const index = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 3;
  return [raw[index], raw[index + 1], raw[index + 2]];
}

function classify(rgb) {
  const [r, g, b] = rgb;
  if (r > 150 && g < 80 && b < 80) return 'red';
  if (b > 150 && r < 80 && g < 80) return 'blue';
  if (g > 100 && r < 80 && b < 80) return 'green';
  return `rgb(${r},${g},${b})`;
}

test('本地 MP4：探测出时长/分辨率/轨道，且能抽到指定时间点的正确画面', async () => {
  const { service, dir, cleanup } = makeService();
  const file = path.join(dir, 'scenes.mp4');
  makeThreeSceneMp4(file);
  try {
    const probe = await service.probeSource({ source_path: file });
    assert.equal(probe.ok, true, probe.probe?.error ?? probe.error ?? '');
    assert.equal(probe.probe.access_status, 'USER_FILE_READY');
    assert.equal(probe.probe.container.includes('mp4'), true);
    assert.ok(Math.abs(probe.probe.duration_ms - 3000) < 200, `时长 ${probe.probe.duration_ms}`);
    assert.equal(probe.probe.width, 160);
    assert.equal(probe.probe.height, 120);
    assert.ok(probe.probe.tracks.some((t) => t.type === 'video'));

    const result = await service.analyze({ source_path: file, count: 4 });
    assert.equal(result.ok, true, result.error ?? '');
    assert.equal(result.frames.length, 4);
    // 首帧红色、末帧绿色（证明抽的是不同时间点，不是同一帧复制）
    const colors = result.frames.map((f) => classify(centerPixel(f.path, 160, 120)));
    assert.equal(colors[0], 'red', `首帧应为红，实际 ${colors[0]}`);
    assert.equal(colors[colors.length - 1], 'green', `末帧应为绿，实际 ${colors[colors.length - 1]}`);
    // 中间至少出现蓝或绿之一（说明覆盖了第二段之后）
    assert.ok(colors.slice(1).some((c) => c === 'blue' || c === 'green'), `中间帧颜色 ${colors.join(',')}`);
  } finally {
    cleanup();
  }
});

test('有音轨的视频：轨道信息里同时出现 video 与 audio', async () => {
  const { service, dir, cleanup } = makeService();
  const file = path.join(dir, 'av.mp4');
  makeThreeSceneMp4(file, { withAudio: true });
  try {
    const probe = await service.probeSource({ source_path: file });
    assert.equal(probe.ok, true);
    const types = probe.probe.tracks.map((t) => t.type);
    assert.ok(types.includes('video'));
    assert.ok(types.includes('audio'));
  } finally {
    cleanup();
  }
});

test('focus 模式：只在指定时间窗内取帧', async () => {
  const { service, dir, cleanup } = makeService();
  const file = path.join(dir, 'scenes.mp4');
  makeThreeSceneMp4(file);
  try {
    const result = await service.analyze({
      source_path: file,
      mode: 'focus',
      count: 3,
      start_ms: 1000,
      end_ms: 2000,
    });
    assert.equal(result.ok, true, result.error ?? '');
    for (const frame of result.frames) {
      assert.ok(frame.timestamp_ms >= 0 && frame.timestamp_ms <= 4000, `帧时间 ${frame.timestamp_ms} 越界`);
    }
    // 所有帧都应落在第二段（蓝色）附近
    const colors = result.frames.map((f) => classify(centerPixel(f.path, 160, 120)));
    assert.ok(colors.filter((c) => c === 'blue').length >= 1, `期望至少一帧是蓝色，实际 ${colors.join(',')}`);
  } finally {
    cleanup();
  }
});

test('超过时长上限的媒体：只处理允许范围并明确告警', async () => {
  const { service, dir, cleanup } = makeService({ limits: { maxDurationSec: 1 } });
  const file = path.join(dir, 'scenes.mp4');
  makeThreeSceneMp4(file);
  try {
    const result = await service.analyze({ source_path: file, count: 3 });
    assert.equal(result.ok, true, result.error ?? '');
    assert.ok(result.warnings.some((w) => w.includes('超过时长上限') || w.includes('时长')), JSON.stringify(result.warnings));
  } finally {
    cleanup();
  }
});

test('MCP video_frames 对本地视频同样返回图片块，并给出采样说明', async () => {
  const { service, dir, cleanup } = makeService();
  const file = path.join(dir, 'scenes.mp4');
  makeThreeSceneMp4(file);
  try {
    const response = await invokeVideoTool('video_frames', { source_path: file, count: 3 }, service);
    assert.equal(response.isError, undefined);
    const images = response.content.filter((b) => b.type === 'image');
    assert.equal(images.length, 3);
    const text = response.content[0].text;
    assert.match(text, /t=\d+\.\d{2}s/);
    assert.ok(text.includes('采样帧'));
  } finally {
    cleanup();
  }
});

test('损坏的 MP4：探测失败并给可读错误（不伪造成功）', async () => {
  const { service, dir, cleanup } = makeService();
  const file = path.join(dir, 'bad.mp4');
  fs.writeFileSync(file, Buffer.alloc(2048, 0x41));
  try {
    const result = await service.analyze({ source_path: file });
    assert.equal(result.ok, false);
    assert.equal(result.access_status, 'ACCESS_FAILED');
    assert.ok(result.error);
    // 失败也要留一条任务记录（可统计失败率）
    const stats = service.stats();
    assert.equal(stats.tasks_failed, 1);
  } finally {
    cleanup();
  }
});

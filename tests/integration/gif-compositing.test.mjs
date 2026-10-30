import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildGif } from '../fixtures/make-gif.mjs';
import { createVideoService } from '../../src/service.js';

function ws() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdu-gifx-'));
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

function gray(file, w, h) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], {
    maxBuffer: 8 * 1024 * 1024,
  });
}

function centerGray(file, w, h) {
  const buf = gray(file, w, h);
  return buf[Math.floor(h / 2) * w + Math.floor(w / 2)];
}

test('GIF 透明度 + disposal：透明帧与前帧合成，不会被当成黑色覆盖', async () => {
  const { dir, service, cleanup } = ws();
  try {
    // 调色板：0=白(255,255,255)、1=黑(0,0,0)；索引 1 作为透明色
    // 帧0：不透明白（100ms）；帧1：整帧透明、disposal=1（保留前帧）；帧2：不透明黑（100ms）
    const gif = path.join(dir, 'alpha.gif');
    fs.writeFileSync(gif, buildGif({
      width: 16,
      height: 16,
      colors: [[255, 255, 255], [0, 0, 0]],
      frames: [
        { delayCs: 10, colorIndex: 0 },
        { delayCs: 10, colorIndex: 1, transparent: true, dispose: 1 },
        { delayCs: 10, colorIndex: 1 },
      ],
      loop: 0,
    }));

    const analyzed = await service.analyze({ source_path: gif, count: 3, mode: 'all' });
    assert.equal(analyzed.ok, true, analyzed.error ?? '');
    assert.equal(analyzed.frames.length, 3, '透明帧不能被丢弃');
    assert.deepEqual(analyzed.frames.map((f) => f.timestamp_ms), [0, 100, 200]);

    const [c0, c1, c2] = analyzed.frames.map((f) => centerGray(f.path, 16, 16));
    assert.ok(c0 > 200, `帧0 应为白，实际灰度 ${c0}`);
    // 关键断言：透明帧应合成到前帧（白），而不是被渲染成黑
    assert.ok(c1 > 200, `透明帧应保留前帧颜色（白），实际灰度 ${c1} —— 说明透明/合成处理有问题`);
    assert.ok(c2 < 60, `帧2 应为黑，实际灰度 ${c2}`);
  } finally {
    cleanup();
  }
});

test('GIF 循环属性不会导致帧数被展开成多轮', async () => {
  const { dir, service, cleanup } = ws();
  try {
    // loop=0 表示无限循环；我们只分析一轮，帧数必须是 4 而不是 4×N
    const gif = path.join(dir, 'loop.gif');
    fs.writeFileSync(gif, buildGif({
      width: 8,
      height: 8,
      colors: [[255, 0, 0], [0, 0, 255]],
      frames: [
        { delayCs: 10, colorIndex: 0 },
        { delayCs: 10, colorIndex: 1 },
        { delayCs: 10, colorIndex: 0 },
        { delayCs: 10, colorIndex: 1 },
      ],
      loop: 0,
    }));
    const analyzed = await service.analyze({ source_path: gif, count: 4, mode: 'all' });
    assert.equal(analyzed.ok, true, analyzed.error ?? '');
    assert.equal(analyzed.frames.length, 4, '无限循环的 GIF 也只分析一轮');
    assert.equal(analyzed.probe?.frame_count ?? analyzed.frame_count, 4);
  } finally {
    cleanup();
  }
});

test('GIF 极短帧延迟（10ms 级）也被保留，不被合并', async () => {
  const { dir, service, cleanup } = ws();
  try {
    const gif = path.join(dir, 'fast.gif');
    fs.writeFileSync(gif, buildGif({
      width: 8,
      height: 8,
      colors: [[255, 0, 0], [0, 0, 255]],
      frames: [
        { delayCs: 2, colorIndex: 0 },
        { delayCs: 2, colorIndex: 1 },
        { delayCs: 2, colorIndex: 0 },
      ],
      loop: 0,
    }));
    const analyzed = await service.analyze({ source_path: gif, count: 3, mode: 'all' });
    assert.equal(analyzed.ok, true, analyzed.error ?? '');
    assert.equal(analyzed.frames.length, 3);
    // 20ms 一帧，时间轴应为 0/20/40
    assert.deepEqual(analyzed.frames.map((f) => f.timestamp_ms), [0, 20, 40]);
  } finally {
    cleanup();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateImageTokens, targetFrameSize, planSampling, detectSceneChanges } from '../../src/sampling.js';
import { validateConfig } from '../../src/config.js';

const cfg = validateConfig({});

test('图片 token 估算与 DeepSeek 计费口径一致（含 MIN_PIXELS 放大）', () => {
  // 提供方会把 < 544×544 的图放大到该下限再计费，所以小图有 ~192 的地板
  // 手算：640x360 → 放大到 725x407 → padded 728x420 → grid 18x10 → 10*(18+1)+2 = 192
  assert.equal(estimateImageTokens(640, 360), 192);
  // 480x270 更小，但放大后落到同一个网格 ⇒ 一样 192（缩得更小并不省钱）
  assert.equal(estimateImageTokens(480, 270), 192);
  assert.equal(estimateImageTokens(544, 544), 184);
  // 852x480 超过下限 → 不放大 → 266
  assert.equal(estimateImageTokens(852, 480), 266);
  // 超大图被压到上限 1024
  assert.equal(estimateImageTokens(1920, 1080), 1024);
  // 非法输入不炸
  assert.equal(estimateImageTokens(0, 0), 0);
  assert.equal(estimateImageTokens(NaN, 10), 0);
});

test('概览模式把像素压到下限附近（不吃 1024 上限，也不小于地板）', () => {
  const sized = targetFrameSize(1920, 1080, cfg);
  // 目标 ≈ 295936 像素，保持 16:9 ⇒ 725x408
  assert.ok(Math.abs(sized.width - 725) <= 2, `实际宽 ${sized.width}`);
  assert.ok(sized.width * sized.height <= 544 * 544 * 1.02);
  assert.equal(sized.scaled, true);
  // 概览下 1920x1080 只需 192 token/帧，而不是 1024
  assert.equal(estimateImageTokens(sized.width, sized.height), 192);

  const small = targetFrameSize(320, 240, cfg);
  assert.equal(small.width, 320);
  assert.equal(small.height, 240);
  assert.equal(small.scaled, false);

  // 竖屏 1080x1920 同样压到像素下限
  const portrait = targetFrameSize(1080, 1920, cfg);
  assert.ok(Math.abs(portrait.height - 725) <= 2, `实际高 ${portrait.height}`);
});

test('detail 模式保留细节，只受最大像素约束', () => {
  const detailed = targetFrameSize(1920, 1080, cfg, { quality: 'detail' });
  assert.equal(detailed.width, 1920);
  assert.equal(detailed.height, 1080);
  assert.equal(detailed.scaled, false);
  // 1080p 单帧 1024 token，这是"看清文字"的代价
  assert.equal(estimateImageTokens(1920, 1080), 1024);
});

test('概览采样：必含首尾帧，且帧数不超过上限', () => {
  const probe = { duration_ms: 10000, width: 640, height: 360, frame_timeline: null };
  const plan = planSampling(cfg, probe, { mode: 'overview', count: 6 });
  assert.equal(plan.plan_count, 6);
  assert.equal(plan.points[0].reason, 'first');
  assert.equal(plan.points[0].timestampMs, 0);
  const last = plan.points[plan.points.length - 1];
  assert.equal(last.reason, 'last');
  // 末帧时间戳会被夹紧到 duration - guard（避免 seek 到末尾取不到帧）
  assert.ok(last.timestampMs <= 10000 && last.timestampMs >= 9800, `末帧时间 ${last.timestampMs}`);
  // 时间单调递增
  for (let i = 1; i < plan.points.length; i += 1) {
    assert.ok(plan.points[i].timestampMs >= plan.points[i - 1].timestampMs);
  }
});

test('末帧时间戳不会正好落在媒体结束时刻（ffmpeg 会取不到帧）', () => {
  const plan = planSampling(cfg, { duration_ms: 3000, width: 160, height: 120 }, { mode: 'overview', count: 4 });
  for (const point of plan.points) {
    assert.ok(point.timestampMs < 3000, `采样点 ${point.timestampMs} 落在媒体末尾，会抽不到帧`);
  }
});

test('场景切换点占用 count 名额，不会让帧数超发', () => {
  const plan = planSampling(cfg, { duration_ms: 20000, width: 640, height: 360 }, {
    mode: 'overview',
    count: 4,
    sceneTimestampsMs: [1000, 5000, 9000, 13000, 17000],
  });
  assert.ok(plan.plan_count <= 4, `实际 ${plan.plan_count} 帧，超过请求的 4 帧`);
  assert.ok(plan.scene_changes_used >= 1);
});

test('GIF 采样按时间轴取点，不按帧序号（帧延迟不均时序号会骗人）', () => {
  // 4 帧，pts 0 / 1000 / 1300 / 2000
  const timeline = [
    { index: 0, ptsMs: 0, durationMs: 1000 },
    { index: 1, ptsMs: 1000, durationMs: 300 },
    { index: 2, ptsMs: 1300, durationMs: 700 },
    { index: 3, ptsMs: 2000, durationMs: 200 },
  ];
  const plan = planSampling(cfg, { duration_ms: 2200, width: 160, height: 120, frame_timeline: timeline }, { mode: 'overview', count: 4 });
  const stamps = plan.points.map((p) => p.timestampMs);
  assert.equal(stamps[0], 0);
  assert.equal(stamps[stamps.length - 1], 2000);
  // 取到的点必须落在真实帧时间上
  for (const stamp of stamps) assert.ok(timeline.some((f) => f.ptsMs === stamp), `采样点 ${stamp} 不在帧时间轴上`);
});

test('成本闸门：图片 token 预算不足时减帧而不是超发', () => {
  const tight = validateConfig({ cost: { maxImageTokens: 400 }, limits: { frameMaxWidth: 640, defaultFrames: 10 } });
  const plan = planSampling(tight, { duration_ms: 10000, width: 640, height: 360 }, { mode: 'overview', count: 10 });
  assert.ok(plan.plan_count <= 3, `预算 400 / 每帧 155 应只能取 2~3 帧，实际 ${plan.plan_count}`);
  assert.ok(plan.budget.image_tokens_total <= 400 || plan.plan_count === 1);
  assert.ok(plan.coverage.notes.some((note) => note.includes('预算')));
});

test('覆盖说明诚实标注盲区', () => {
  const plan = planSampling(cfg, { duration_ms: 100000, width: 640, height: 360 }, { mode: 'overview', count: 4 });
  assert.equal(plan.coverage.covers_full_duration, true);
  assert.ok(plan.coverage.max_gap_ms > 1000);
  assert.ok(plan.coverage.notes.some((note) => note.includes('可能被漏掉')));
});

test('局部精读模式围绕指定窗口加密', () => {
  const plan = planSampling(cfg, { duration_ms: 60000, width: 640, height: 360 }, {
    mode: 'focus',
    count: 4,
    startMs: 30000,
    endMs: 32000,
  });
  assert.equal(plan.mode, 'focus');
  for (const point of plan.points) {
    assert.ok(point.timestampMs >= 28000 && point.timestampMs <= 34000, `采样点 ${point.timestampMs} 跑出窗口`);
  }
});

test('抽样计划数量不会超过 limits.maxFrames', () => {
  const plan = planSampling(cfg, { duration_ms: 60000, width: 640, height: 360 }, {
    mode: 'overview',
    count: 999,
  });
  assert.ok(plan.plan_count <= cfg.limits.maxFrames);
});

test('scene 检测在关闭时直接跳过（不启动子进程）', async () => {
  const off = validateConfig({ sampling: { sceneDetect: false } });
  const result = await detectSceneChanges(off, { kind: 'local', path: 'x.gif' });
  assert.equal(result.ok, true);
  assert.equal(result.timestampsMs.length, 0);
  assert.equal(result.skipped, 'disabled');
});

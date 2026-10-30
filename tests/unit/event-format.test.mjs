import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCompactEvent,
  normalizeTimeline,
  deriveEvidenceFrames,
  estimateEventTokens,
  isCompactEvent,
  EVENT_TOKEN_TARGET,
  TIMELINE_TOKEN_TARGET,
} from '../../src/event-format.js';

const FRAMES = [
  { frame_id: 'f1', timestamp_ms: 0 },
  { frame_id: 'f2', timestamp_ms: 480 },
  { frame_id: 'f3', timestamp_ms: 1480 },
  { frame_id: 'f4', timestamp_ms: 2000 },
  { frame_id: 'f5', timestamp_ms: 3480 },
];

test('token 预算：一条事件在 50 内需要哪些字段（实测口径）', () => {
  const minimal = { t: [1480, 2000], e: '猫支起上身抬头' };
  const withKind = { ...minimal, k: 'mv' };
  const withContinuity = { ...withKind, m: 1 };
  const withActor = { ...withContinuity, a: 'cat' };
  const withConfidence = { ...withActor, c: 0.8 };

  assert.ok(estimateEventTokens(minimal) <= EVENT_TOKEN_TARGET, `极简版 ${estimateEventTokens(minimal)}`);
  assert.ok(estimateEventTokens(withKind) <= EVENT_TOKEN_TARGET);
  assert.ok(estimateEventTokens(withContinuity) <= EVENT_TOKEN_TARGET);
  assert.ok(
    estimateEventTokens(withActor) <= EVENT_TOKEN_TARGET,
    `五字段版 ${estimateEventTokens(withActor)} 应仍在 ${EVENT_TOKEN_TARGET} 内`,
  );
  // 加置信度就会超——这正是"可选字段按需出现"的理由
  assert.ok(
    estimateEventTokens(withConfidence) > EVENT_TOKEN_TARGET,
    `加 c 后 ${estimateEventTokens(withConfidence)} 应超过预算，否则测试口径变了`,
  );
});

test('紧凑事件：必填 t + e，其余可选', () => {
  const result = normalizeCompactEvent({ t: [1480, 2000], e: '猫支起上身抬头' });
  assert.equal(result.ok, true, result.errors.join(';'));
  assert.deepEqual(result.compact, { t: [1480, 2000], e: '猫支起上身抬头' });
  assert.equal(result.internal.start_ms, 1480);
  assert.equal(result.internal.end_ms, 2000);
  assert.equal(result.internal.observation_or_inference, 'observation');
  assert.equal(result.internal.worth_memory, 0);
});

test('单点事件 t:[x] 合法，end_ms 为 null', () => {
  const result = normalizeCompactEvent({ t: [500], e: '一次性闪光' });
  assert.equal(result.ok, true);
  assert.equal(result.internal.end_ms, null);
});

test('t 非法（缺、非数组、倒序、超时长）都被拒', () => {
  const ctx = { durationMs: 3520 };
  assert.equal(normalizeCompactEvent({ e: 'x' }).ok, false);
  assert.equal(normalizeCompactEvent({ t: 'abc', e: 'x' }).ok, false);
  assert.equal(normalizeCompactEvent({ t: [2000, 1000], e: 'x' }).ok, false);
  assert.equal(normalizeCompactEvent({ t: [99999], e: 'x' }, ctx).ok, false);
});

test('e 必填，且提示"写变化而不是画面"', () => {
  const result = normalizeCompactEvent({ t: [0] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('发生了什么变化')));
});

test('k 必须是枚举；非法值报错', () => {
  assert.equal(normalizeCompactEvent({ t: [0], e: 'x', k: 'mv' }).ok, true);
  const bad = normalizeCompactEvent({ t: [0], e: 'x', k: 'jump' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('k 必须是')));
});

test('m 只能 0/1/2，并映射成 once/continuous/repeated', () => {
  assert.equal(normalizeCompactEvent({ t: [0], e: 'x', m: 0 }).internal.continuity, 'once');
  assert.equal(normalizeCompactEvent({ t: [0], e: 'x', m: 1 }).internal.continuity, 'continuous');
  assert.equal(normalizeCompactEvent({ t: [0], e: 'x', m: 2 }).internal.continuity, 'repeated');
  assert.equal(normalizeCompactEvent({ t: [0], e: 'x', m: 5 }).ok, false);
});

test('x:1 标成推断；默认按观察', () => {
  assert.equal(normalizeCompactEvent({ t: [0], e: 'x' }).internal.observation_or_inference, 'observation');
  assert.equal(normalizeCompactEvent({ t: [0], e: 'x', x: 1 }).internal.observation_or_inference, 'inference');
});

test('c 非法时忽略并告警，不编造分数', () => {
  const result = normalizeCompactEvent({ t: [0], e: 'x', c: 42 });
  assert.equal(result.ok, true);
  assert.equal(result.internal.confidence, null);
  assert.ok(result.warnings.some((w) => w.includes('c 不在 0~1')));
});

test('w:1 才标记为值得长期记忆', () => {
  assert.equal(normalizeCompactEvent({ t: [0], e: 'x' }).internal.worth_memory, 0);
  assert.equal(normalizeCompactEvent({ t: [0], e: 'x', w: 1 }).internal.worth_memory, 1);
});

test('证据帧按时间范围派生：窗口内的帧全收', () => {
  const ids = deriveEvidenceFrames(FRAMES, 1400, 2100);
  assert.deepEqual(ids, ['f3', 'f4']);
});

test('窗口内没有帧时取最近一帧（不给空证据）', () => {
  const ids = deriveEvidenceFrames(FRAMES, 1200, 1400);
  assert.equal(ids.length, 1);
  assert.equal(ids[0], 'f3');
});

test('显式传帧会给出"一般不必写"的告警', () => {
  const result = normalizeCompactEvent({ t: [0], e: 'x', f: ['f1'] });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes('不必写')));
});

test('整条时间线：按时间排序，并汇总 token', () => {
  const result = normalizeTimeline([
    { t: [1480, 2000], e: '支起上身抬头', k: 'mv', m: 1 },
    { t: [0, 480], e: '平趴不动', k: 'st', m: 0 },
  ], { durationMs: 3520 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.events.map((e) => e.start_ms), [0, 1480]);
  assert.ok(result.tokens > 0);
  assert.ok(result.tokens <= TIMELINE_TOKEN_TARGET);
});

test('整条时间线超过预算时拒收并提示压缩', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    t: [i * 100, i * 100 + 50],
    e: '白猫在台面上持续做出很细微的姿态调整变化',
    k: 'mv',
    m: 1,
    a: 'cat',
    c: 0.8,
  }));
  const result = normalizeTimeline(many, { durationMs: 100000 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('超过预算')));
});

test('单条超 50 token 只告警不阻断', () => {
  const result = normalizeTimeline([{
    t: [0, 1000],
    e: '白猫从平趴姿势支起上身、头朝上抬起，前肢撑在台面上，随后又慢慢趴回去，整个过程持续约两秒',
    k: 'mv',
    m: 1,
    a: 'cat',
    c: 0.8,
  }], { durationMs: 3520 });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes('目标 ≤50')));
});

test('isCompactEvent 能区分新旧格式', () => {
  assert.equal(isCompactEvent({ t: [0], e: 'x' }), true);
  assert.equal(isCompactEvent({ k: 'mv' }), true);
  assert.equal(isCompactEvent({ start_ms: 0, description: 'x' }), false);
});

test('空数组与超量都被拒', () => {
  assert.equal(normalizeTimeline([]).ok, false);
  assert.equal(normalizeTimeline(Array.from({ length: 61 }, () => ({ t: [0], e: 'x' }))).ok, false);
});

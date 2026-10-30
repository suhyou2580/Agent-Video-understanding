import test from 'node:test';
import assert from 'node:assert/strict';

import { validateEvent, validateEvents } from '../../src/events.js';

const FRAMES = new Set(['F1', 'F2', 'F3']);

test('合法事件通过，且保留 observation/inference 与 uncertainty', () => {
  const result = validateEvent({
    start_ms: 1000,
    end_ms: 2000,
    description: '画面出现一辆红色汽车从左向右驶过',
    evidence_frame_ids: ['F1', 'F2'],
    observation_or_inference: 'observation',
    uncertainty: 'low',
    confidence: 0.8,
  }, { durationMs: 10000, frameIds: FRAMES });
  assert.equal(result.ok, true, result.errors.join(';'));
  assert.equal(result.event.observation_or_inference, 'observation');
  assert.equal(result.event.uncertainty, 'low');
  assert.equal(result.event.confidence, 0.8);
});

test('没有证据的事件必须被拒绝（不允许凭空描述）', () => {
  const result = validateEvent({
    start_ms: 0,
    description: '视频里有人在哭',
    observation_or_inference: 'inference',
    uncertainty: 'medium',
  }, { durationMs: 10000, frameIds: FRAMES });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('可追溯')));
});

test('转录引用可以代替帧证据', () => {
  const result = validateEvent({
    start_ms: 0,
    description: '他说了一句"我们走吧"',
    transcript_refs: ['T1'],
    observation_or_inference: 'observation',
    uncertainty: 'low',
  }, { durationMs: 10000, frameIds: FRAMES });
  assert.equal(result.ok, true, result.errors.join(';'));
});

test('证据帧 id 全不属于本任务时拒绝；部分不属于则丢弃并告警', () => {
  const allWrong = validateEvent({
    start_ms: 0,
    description: '某事件',
    evidence_frame_ids: ['X1', 'X2'],
    observation_or_inference: 'observation',
    uncertainty: 'low',
  }, { durationMs: 10000, frameIds: FRAMES });
  assert.equal(allWrong.ok, false);

  const partial = validateEvent({
    start_ms: 0,
    description: '某事件',
    evidence_frame_ids: ['F1', 'X9'],
    observation_or_inference: 'observation',
    uncertainty: 'low',
  }, { durationMs: 10000, frameIds: FRAMES });
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.event.evidence_frame_ids, ['F1']);
  assert.ok(partial.warnings.some((w) => w.includes('不属于本任务')));
});

test('时间范围必须合理：负值、倒序、超出时长都要拒绝', () => {
  const base = {
    description: 'x',
    evidence_frame_ids: ['F1'],
    observation_or_inference: 'observation',
    uncertainty: 'low',
  };
  assert.equal(validateEvent({ ...base, start_ms: -1 }, { durationMs: 10000 }).ok, false);
  assert.equal(validateEvent({ ...base, start_ms: 5000, end_ms: 4000 }, { durationMs: 10000 }).ok, false);
  assert.equal(validateEvent({ ...base, start_ms: 20000 }, { durationMs: 10000 }).ok, false);
  // 允许 1s 容差（容器时长偶尔比末帧略短）
  assert.equal(validateEvent({ ...base, start_ms: 10800 }, { durationMs: 10000 }).ok, true);
});

test('未提供 uncertainty 时按 high 保守处理并告警', () => {
  const result = validateEvent({
    start_ms: 0,
    description: '某事件',
    evidence_frame_ids: ['F1'],
    observation_or_inference: 'inference',
  }, { durationMs: 10000, frameIds: FRAMES });
  assert.equal(result.ok, true);
  assert.equal(result.event.uncertainty, 'high');
  assert.ok(result.warnings.some((w) => w.includes('high')));
});

test('confidence 非法时置 null，不编造分数', () => {
  const result = validateEvent({
    start_ms: 0,
    description: '某事件',
    evidence_frame_ids: ['F1'],
    observation_or_inference: 'observation',
    uncertainty: 'low',
    confidence: 42,
  }, { durationMs: 10000, frameIds: FRAMES });
  assert.equal(result.ok, true);
  assert.equal(result.event.confidence, null);
  assert.ok(result.warnings.some((w) => w.includes('confidence')));
});

test('observation_or_inference 必填且只能是两个枚举值', () => {
  const missing = validateEvent({
    start_ms: 0, description: 'x', evidence_frame_ids: ['F1'], uncertainty: 'low',
  }, { durationMs: 10000, frameIds: FRAMES });
  assert.equal(missing.ok, false);

  const wrong = validateEvent({
    start_ms: 0, description: 'x', evidence_frame_ids: ['F1'],
    observation_or_inference: 'maybe', uncertainty: 'low',
  }, { durationMs: 10000, frameIds: FRAMES });
  assert.equal(wrong.ok, false);
});

test('批量校验：失败时整体不落库，并给出逐条 index', () => {
  const result = validateEvents([
    { start_ms: 0, description: 'ok', evidence_frame_ids: ['F1'], observation_or_inference: 'observation', uncertainty: 'low' },
    { start_ms: 100, description: '', observation_or_inference: 'observation', uncertainty: 'low' },
  ], { durationMs: 10000, frameIds: FRAMES });
  assert.equal(result.ok, false);
  assert.equal(result.events.length, 0);
  assert.equal(result.errors[0].index, 1);
});

test('批量校验成功时按开始时间排序', () => {
  const result = validateEvents([
    { start_ms: 5000, description: '晚', evidence_frame_ids: ['F1'], observation_or_inference: 'observation', uncertainty: 'low' },
    { start_ms: 1000, description: '早', evidence_frame_ids: ['F2'], observation_or_inference: 'observation', uncertainty: 'low' },
  ], { durationMs: 10000, frameIds: FRAMES });
  assert.equal(result.ok, true);
  assert.deepEqual(result.events.map((e) => e.description), ['早', '晚']);
});

test('空数组与超量都拒绝', () => {
  assert.equal(validateEvents([], { durationMs: 1000 }).ok, false);
  const many = Array.from({ length: 201 }, () => ({
    start_ms: 0, description: 'x', evidence_frame_ids: ['F1'], observation_or_inference: 'observation', uncertainty: 'low',
  }));
  assert.equal(validateEvents(many, { durationMs: 1000, frameIds: FRAMES }).ok, false);
});

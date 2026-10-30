#!/usr/bin/env node
/**
 * 环境自检：把"能不能用"一次说清楚，不用翻日志。
 *
 *   node scripts/doctor.mjs
 *   node scripts/doctor.mjs --bilibili BV1xxx   # 额外验证一个 B 站视频
 *
 * 退出码 0 = 核心可用；1 = 有阻断项。
 */

import fs from 'node:fs';
import path from 'node:path';

import { createVideoService } from '../src/service.js';
import { estimateImageTokens } from '../src/sampling.js';
import { PLUGIN_ROOT } from '../src/paths.js';
import { assertSafeMediaUrl } from '../src/net-guard.js';

const args = process.argv.slice(2);
const biliIndex = args.indexOf('--bilibili');
const biliTarget = biliIndex >= 0 ? args[biliIndex + 1] : null;

const problems = [];
const out = { ok: true };

const service = createVideoService({ baseDir: PLUGIN_ROOT });
try {
  const versions = await service.toolVersions();
  out.ffmpeg = versions.ffmpeg ?? null;
  out.ffprobe = versions.ffprobe ?? null;
  if (!out.ffmpeg) problems.push('ffmpeg 不可用：请安装 FFmpeg 并确保在 PATH 中，或用 config.ffmpegPath 指定');
  if (!out.ffprobe) problems.push('ffprobe 不可用（通常与 ffmpeg 同目录）');

  const health = service.health();
  out.database = {
    path: health.databasePath,
    schema: health.schemaVersion,
    integrity: health.integrity,
    counts: health.counts,
  };
  if (!health.ok) problems.push(`数据库不健康：${JSON.stringify(health.errors)}`);

  out.limits = {
    max_frames: service.cfg.limits.maxFrames,
    default_frames: service.cfg.limits.defaultFrames,
    max_duration_s: service.cfg.limits.maxDurationSec,
    max_bytes: service.cfg.limits.maxBytes,
    max_image_tokens: service.cfg.cost.maxImageTokens,
    scene_detect: service.cfg.sampling.sceneDetect,
  };
  out.tokens_per_frame = {
    overview_725x408: estimateImageTokens(725, 408),
    detail_1920x1080: estimateImageTokens(1920, 1080),
    note: '提供方会把 <544x544 的图放大到该下限再计费，所以小图有约 192 token 的地板',
  };

  // 网络安全闸门自检（不发真实请求，只验证判定逻辑）
  const blocked = await assertSafeMediaUrl('http://127.0.0.1/a.mp4');
  const allowed = await assertSafeMediaUrl('https://1.1.1.1/a.mp4');
  out.net_guard = { blocks_loopback: !blocked.ok, allows_public_ip: allowed.ok };
  if (blocked.ok || !allowed.ok) problems.push('net-guard 判定异常');

  // 记忆插件（可选依赖）
  try {
    const { resolveMemory } = await import('../src/memory-bridge.js');
    const memory = await resolveMemory();
    out.memory_plugin = memory.ok
      ? { ok: true, source: memory.source, has_structured_write: typeof memory.service?.writeStructured === 'function' }
      : { ok: false, error: memory.error };
    if (memory.ok && out.memory_plugin.has_structured_write !== true) {
      problems.push('记忆插件版本过旧：缺少 writeStructured 接口，video_remember 将不可用');
    }
  } catch (error) {
    out.memory_plugin = { ok: false, error: String(error?.message ?? error) };
  }

  if (biliTarget) {
    const resolved = await service.resolveBilibili(biliTarget);
    out.bilibili = {
      target: biliTarget,
      access_status: resolved.access_status,
      title: resolved.metadata?.title ?? null,
      duration_s: resolved.metadata?.duration_s ?? null,
      subtitle_langs: (resolved.subtitles ?? []).map((s) => s.lan),
      has_media: resolved.has_media,
      warnings: resolved.warnings,
    };
  }
} catch (error) {
  problems.push(String(error?.message ?? error));
} finally {
  service.close();
}

out.problems = problems;
out.ok = problems.length === 0;
console.log(JSON.stringify(out, null, 2));
process.exitCode = out.ok ? 0 : 1;

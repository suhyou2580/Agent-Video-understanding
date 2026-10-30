/**
 * 真实网络联调（不参与 `node --test` 自动发现，需手动跑）：
 *
 *   node tests/live/bilibili.live.mjs
 *
 * 依赖外网与 B 站接口，因此不能放进常规 CI —— 接口/网络变化会让它红，
 * 但那时也该知道真实状态。断言写得宽松：只验证"状态诚实 + 能拿到就真拿到"。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createVideoService } from '../../src/service.js';
import { invokeVideoTool } from '../../src/mcp-tools.js';
import { parseBilibiliTarget } from '../../src/adapters/bilibili.js';

const BV = 'BV1GJ411x7h7';
let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdu-live-'));
const service = createVideoService({
  baseDir: dir,
  databasePath: path.join(dir, 'video.db'),
  config: { workDir: dir },
});

try {
  console.log('\n[1] 目标解析');
  const parsed = parseBilibiliTarget(`https://www.bilibili.com/video/${BV}/?p=1`);
  check('从 URL 解析出 bvid', parsed.ok && parsed.bvid === BV, JSON.stringify(parsed));
  const shortLink = parseBilibiliTarget('https://b23.tv/abcdefg');
  check('b23 短链给出可读的拒绝', !shortLink.ok && /短链/.test(shortLink.error), shortLink.error);

  console.log('\n[2] 元数据解析（不抽帧）');
  const resolved = await service.resolveBilibili(BV);
  console.log(`  access_status = ${resolved.access_status}`);
  check('能拿到标题', Boolean(resolved.metadata?.title), resolved.metadata?.title ?? '');
  check('能拿到时长', Number(resolved.metadata?.duration_s) > 0, `${resolved.metadata?.duration_s}s`);
  check('access_status 在合法枚举内',
    ['METADATA_ONLY', 'TRANSCRIPT_READY', 'VIDEO_READY', 'AUDIO_VIDEO_READY', 'ACCESS_RESTRICTED', 'ACCESS_FAILED']
      .includes(resolved.access_status), resolved.access_status);
  check('返回里明确说明不是官方 API', resolved.warnings.some((w) => w.includes('不是官方开放平台')), '');
  if (!resolved.has_media) {
    console.log('  （当前网络/登录态下没拿到媒体流，后续抽帧测试跳过）');
  }

  console.log('\n[3] 真实抽帧（走 CDN + ffmpeg range 请求）');
  const frames = await invokeVideoTool('video_frames', { source_bilibili: BV, count: 3 }, service);
  if (frames.isError) {
    const body = JSON.parse(frames.content[0].text);
    console.log(`  抽帧未成功：${body.error} / access_status=${body.access_status}`);
    check('抽帧失败时如实报错（不伪造结果）', Boolean(body.error), body.error);
  } else {
    const images = frames.content.filter((b) => b.type === 'image');
    const text = frames.content[0].text;
    check('返回了图片块', images.length >= 1, `${images.length} 张`);
    check('图片是 JPEG', images.every((i) => Buffer.from(i.data, 'base64')[0] === 0xff), '');
    check('文字里有时间戳', /t=\d+\.\d{2}s/.test(text), '');
    check('文字里有 B 站来源说明', text.includes('网页播放器公开接口'), '');
    check('文字里有采样限制提醒', text.includes('采样帧'), '');
    const avgBytes = Math.round(images.reduce((acc, i) => acc + Buffer.from(i.data, 'base64').length, 0) / Math.max(1, images.length));
    console.log(`  平均帧大小 ${avgBytes} 字节；token 估算约 ${avgBytes > 0 ? '见返回文本' : '?'}`);
  }

  console.log('\n[4] 统计口径');
  const stats = service.stats();
  check('统计能反映任务与失败率', stats.tasks_total >= 1, JSON.stringify({
    tasks: stats.tasks_total, failed: stats.tasks_failed, frames: stats.frames_seen, tokens: stats.image_tokens_total,
  }));

  console.log('\n[5] 不存在的视频');
  const missing = await service.resolveBilibili('BV0000000000');
  check('不存在的视频给出明确状态', !missing.ok && ['ACCESS_FAILED', 'ACCESS_RESTRICTED'].includes(missing.access_status),
    `${missing.access_status} / ${missing.error}`);
} finally {
  service.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项未通过`}`);
process.exitCode = failures === 0 ? 0 : 1;

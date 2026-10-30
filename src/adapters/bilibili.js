/**
 * B 站来源适配器。
 *
 * **必须明确的能力边界（写进代码注释，也写进返回给模型的文案里）**：
 *  1. B 站**官方开放平台**（open.bilibili.com）提供的是应用入驻、授权、稿件管理
 *     与部分数据能力，**不提供任意公开视频的媒体流/字幕下载**。所以本适配器
 *     不能被称为"官方 API"，它用的是**网页播放器自身的公开接口**。
 *  2. 不绕过登录、付费、DRM、地区限制或风控。拿不到就如实返回 ACCESS_RESTRICTED
 *     / ACCESS_FAILED，绝不假装看过。
 *  3. `x/player/wbi/playurl`（带签名）会触发 412 风控，本适配器**不碰它**；
 *     只用不需要签名的 `x/player/playurl`。拿不到就降级。
 *  4. 需要登录态才能取的高清/字幕，交给用户自己的浏览器会话（pc-browser）解决，
 *     不偷 Cookie、不写日志。
 *
 * 状态机（与工作流程规范 §2 一致）：
 *   METADATA_ONLY → 只拿到标题等元数据
 *   TRANSCRIPT_READY → 拿到字幕
 *   VIDEO_READY → 拿到可解码视频流
 *   AUDIO_VIDEO_READY → 视频+音频都有
 *   ACCESS_RESTRICTED → 需要登录/权限不足/风控
 *   ACCESS_FAILED → 网络或接口失败
 */

import { assertSafeMediaUrl } from '../net-guard.js';

const API_VIEW = 'https://api.bilibili.com/x/web-interface/view';
const API_PLAYER = 'https://api.bilibili.com/x/player/v2';
const API_PLAYURL = 'https://api.bilibili.com/x/player/playurl';

const DEFAULT_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
};

/** 从 URL / 纯 ID 里解析出 bvid / aid / 分P。 */
export function parseBilibiliTarget(input) {
  const text = String(input ?? '').trim();
  if (text.length === 0) return { ok: false, error: '空输入' };

  let bvid = null;
  let aid = null;
  let page = 1;

  const bvMatch = text.match(/BV([0-9A-Za-z]{10})/);
  if (bvMatch) bvid = `BV${bvMatch[1]}`;
  const avMatch = text.match(/\bav(\d+)\b/i);
  if (avMatch) aid = Number(avMatch[1]);
  const pageMatch = text.match(/[?&]p=(\d+)/);
  if (pageMatch) page = Math.max(1, Number(pageMatch[1]));

  // 短链 b23.tv 需要额外解析，这里明确不支持（会返回可读错误而不是瞎猜）
  if (!bvid && !aid && /b23\.tv/i.test(text)) {
    return { ok: false, error: '暂不支持 b23.tv 短链：请提供完整的 bilibili.com/video/BV... 链接或 BV 号' };
  }
  if (!bvid && !aid) return { ok: false, error: '无法从输入里识别 BV 号或 av 号' };
  return { ok: true, bvid, aid, page };
}

async function getJson(url, { timeoutMs = 12000, headers = {} } = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { ...DEFAULT_HEADERS, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, error: `响应不是 JSON（HTTP ${response.status}）`, status: response.status, ms: Date.now() - started };
    }
    return { ok: response.ok, status: response.status, body, ms: Date.now() - started };
  } catch (error) {
    const name = error?.name === 'TimeoutError' ? '请求超时' : String(error?.message ?? error);
    return { ok: false, error: name.slice(0, 160), ms: Date.now() - started };
  }
}

/** 把 B 站错误码翻成可执行的说明（而不是让模型瞎猜）。 */
function explainCode(code, message) {
  const map = {
    '-101': '账号未登录：该内容需要登录态才能访问（可用你自己的浏览器会话，或只做元数据/字幕）',
    '-403': '访问被拒绝：可能需要登录或权限不足',
    '-404': '视频不存在或已删除',
    '-352': '触发风控校验：本适配器不做签名绕过，请改用用户提供的文件或稍后重试',
    '62002': '稿件不可见（私有/审核中）',
    '62004': '稿件审核中',
    '87007': '充电专属内容：需要付费/权限，不绕过',
    '87008': '付费内容：不绕过',
  };
  const key = String(code);
  return map[key] ? `${map[key]}（code=${code}）` : `B 站接口返回 code=${code}${message ? `：${message}` : ''}`;
}

/**
 * 解析一个 B 站视频，返回可交给 analyze() 的 source 与能力状态。
 * @param {string} input - URL 或 BV/av 号
 * @param {{ cid?: number, page?: number, timeoutMs?: number }} [options]
 */
export async function resolveBilibiliSource(input, options = {}) {
  const parsed = parseBilibiliTarget(input);
  if (!parsed.ok) {
    return { ok: false, access_status: 'ACCESS_FAILED', error: parsed.error, metadata: null, source: null };
  }
  const timeoutMs = options.timeoutMs ?? 12000;
  const warnings = [];
  warnings.push('本适配器使用 B 站**网页播放器公开接口**，不是官方开放平台 API；不绕过登录/付费/风控。');

  // ── 1) 元数据 ──
  const query = new URLSearchParams();
  if (parsed.bvid) query.set('bvid', parsed.bvid);
  else query.set('aid', String(parsed.aid));
  const view = await getJson(`${API_VIEW}?${query.toString()}`, { timeoutMs });
  if (!view.ok || !view.body) {
    return {
      ok: false,
      access_status: 'ACCESS_FAILED',
      error: `元数据获取失败：${view.error ?? '未知原因'}`,
      metadata: null,
      source: null,
      warnings,
    };
  }
  if (view.body.code !== 0) {
    const restricted = ['-101', '-403', '62002', '-352', '87007', '87008'].includes(String(view.body.code));
    return {
      ok: false,
      access_status: restricted ? 'ACCESS_RESTRICTED' : 'ACCESS_FAILED',
      error: explainCode(view.body.code, view.body.message),
      metadata: null,
      source: null,
      warnings,
    };
  }

  const data = view.body.data;
  const pageIndex = Math.min(Math.max(1, options.page ?? parsed.page), Array.isArray(data.pages) ? data.pages.length : 1);
  const pageData = Array.isArray(data.pages) ? data.pages[pageIndex - 1] : null;
  const cid = options.cid ?? pageData?.cid ?? data.cid;
  const metadata = {
    bvid: data.bvid ?? parsed.bvid,
    aid: data.aid ?? parsed.aid,
    title: data.title ?? null,
    owner: data.owner?.name ?? null,
    duration_s: data.duration ?? null,
    page: pageIndex,
    page_title: pageData?.part ?? null,
    pages: Array.isArray(data.pages) ? data.pages.length : 1,
    cid,
    pubdate: data.pubdate ?? null,
    desc_short: typeof data.desc === 'string' ? data.desc.slice(0, 200) : null,
  };

  // ── 2) 字幕（需要登录态，没有就如实降级）──
  let subtitles = [];
  const player = await getJson(`${API_PLAYER}?bvid=${metadata.bvid}&cid=${cid}`, { timeoutMs });
  if (player.ok && player.body?.code === 0) {
    const list = player.body.data?.subtitle?.subtitles ?? [];
    subtitles = list.map((item) => ({
      lan: item.lan,
      lan_doc: item.lan_doc,
      url: item.subtitle_url ? String(item.subtitle_url).replace(/^\/\//, 'https://') : null,
    })).filter((item) => item.url);
    if (subtitles.length === 0) {
      warnings.push('该视频没有可见字幕（未登录账号通常看不到 CC 字幕；这不代表视频没有语音）。');
    }
  } else if (player.body?.code === -101) {
    warnings.push('字幕接口提示未登录：字幕信息可能缺失。');
  }

  // ── 3) 媒体地址（不签名接口；拿不到就降级）──
  const playUrl = `${API_PLAYURL}?bvid=${metadata.bvid}&cid=${cid}&fnval=16&qn=${options.qn ?? 64}&fourk=0`;
  const play = await getJson(playUrl, {
    timeoutMs,
    headers: { referer: `https://www.bilibili.com/video/${metadata.bvid}/` },
  });
  let videoUrl = null;
  let audioUrl = null;
  if (play.ok && play.body?.code === 0) {
    const dash = play.body.data?.dash;
    if (dash?.video?.length > 0) {
      // 选带宽最高的那路（同清晰度多编码时优先 h264，兼容性最好）
      const sorted = [...dash.video].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
      const h264 = sorted.find((item) => String(item.codecs ?? '').startsWith('avc'));
      videoUrl = (h264 ?? sorted[0]).baseUrl ?? (h264 ?? sorted[0]).base_url ?? null;
      if (dash.audio?.length > 0) {
        const bestAudio = [...dash.audio].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
        audioUrl = bestAudio.baseUrl ?? bestAudio.base_url ?? null;
      }
    } else if (play.body.data?.durl?.length > 0) {
      // 老接口（flv/mp4 单文件）
      videoUrl = play.body.data.durl[0].url ?? null;
    }
  } else {
    const code = play.body?.code;
    const restricted = ['-101', '-403', '-352', '87007', '87008'].includes(String(code));
    warnings.push(`媒体地址获取失败：${code !== undefined ? explainCode(code, play.body?.message) : play.error ?? '未知原因'}`);
    if (restricted && subtitles.length === 0) {
      return {
        ok: false,
        access_status: 'ACCESS_RESTRICTED',
        error: explainCode(code, play.body?.message),
        metadata,
        subtitles,
        source: null,
        warnings,
      };
    }
  }

  // ── 4) 状态判定（如实）──
  let accessStatus;
  if (videoUrl && audioUrl) accessStatus = 'AUDIO_VIDEO_READY';
  else if (videoUrl) accessStatus = 'VIDEO_READY';
  else if (subtitles.length > 0) accessStatus = 'TRANSCRIPT_READY';
  else accessStatus = 'METADATA_ONLY';

  if (accessStatus === 'METADATA_ONLY') {
    warnings.push('只拿到元数据：没有任何画面被分析过。不要基于标题/简介描述视频内容。');
  }

  // ── 5) CDN 地址也要过内网校验（防止被构造的地址打内网）──
  let source = null;
  if (videoUrl) {
    const guard = await assertSafeMediaUrl(videoUrl, { allowHosts: ['bilivideo.com', 'bilivideo.cn', 'bilibili.com', 'akamaized.net', 'bilivideo.net'] });
    if (!guard.ok) {
      warnings.push(`CDN 地址未通过安全校验：${guard.error}`);
      accessStatus = subtitles.length > 0 ? 'TRANSCRIPT_READY' : 'METADATA_ONLY';
    } else {
      source = {
        kind: 'remote',
        url: guard.url.toString(),
        headers: {
          Referer: `https://www.bilibili.com/video/${metadata.bvid}/`,
          'User-Agent': DEFAULT_HEADERS['user-agent'],
          Origin: 'https://www.bilibili.com',
        },
        audio_url: audioUrl,
        audio_headers: {
          Referer: `https://www.bilibili.com/video/${metadata.bvid}/`,
          'User-Agent': DEFAULT_HEADERS['user-agent'],
        },
      };
    }
  }

  return {
    ok: accessStatus !== 'METADATA_ONLY' && accessStatus !== 'ACCESS_FAILED',
    access_status: accessStatus,
    metadata,
    subtitles,
    source,
    audio_url: audioUrl,
    warnings,
    error: accessStatus === 'ACCESS_RESTRICTED' ? warnings[warnings.length - 1] : null,
  };
}

/** 取字幕文本（SRT/VTT 走同一套解析）。 */
export async function fetchSubtitleText(url, { timeoutMs = 12000 } = {}) {
  const guard = await assertSafeMediaUrl(url, { allowHosts: ['hdslb.com', 'bilibili.com', 'bilivideo.com'] });
  if (!guard.ok) return { ok: false, error: `字幕地址未通过安全校验：${guard.error}` };
  const result = await getJson(guard.url.toString(), { timeoutMs, headers: { referer: 'https://www.bilibili.com/' } });
  if (!result.ok || !result.body) return { ok: false, error: result.error ?? '字幕下载失败' };
  const body = result.body;
  // B 站字幕通常是 {body:[{from,to,content}]}
  if (Array.isArray(body?.body)) {
    return {
      ok: true,
      cues: body.body.map((item) => ({
        start_ms: Math.round(Number(item.from) * 1000),
        end_ms: Math.round(Number(item.to) * 1000),
        text: String(item.content ?? '').trim(),
      })).filter((cue) => cue.text.length > 0),
    };
  }
  return { ok: false, error: '字幕格式未识别（期望 {"body":[{"from","to","content"}]}）' };
}

/**
 * 远程 URL 的安全闸门。
 *
 * 为什么必须有：`ffmpeg -i <url>` 会**自己发起网络请求**，前置的 URL 校验管不到
 * 它内部的重定向与后续连接（意见稿 §7.1 明确点出的缺口）。所以这里做三件事：
 *  1. 白名单协议（只 http/https）；
 *  2. DNS 解析后逐个地址判定，禁止本机/内网/环回/链路本地/CGNAT/保留地址；
 *  3. 把校验过的 URL 交给 ffmpeg，并强制 `-protocol_whitelist` + IO 超时。
 *
 * **残余风险（如实说明）**：ffmpeg 建立连接时会**再次解析 DNS**，
 * 校验与实际连接之间理论上存在 DNS rebinding 窗口。彻底消除需要本机中继代理
 * （把字节流经我们自己的、已钉住 IP 的连接转发），第一版没有实现，见 docs/LIMITS。
 */

import dns from 'node:dns/promises';
import net from 'node:net';

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

const V4_BLOCKS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** 判断 IPv4 是否属于必须拒绝的地址段。 */
export function isBlockedIpv4(ip) {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  for (const [base, bits] of V4_BLOCKS) {
    const baseValue = ipv4ToInt(base);
    if (baseValue === null) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) === (baseValue & mask)) return true;
  }
  return false;
}

/** 判断任意 IP 字符串（v4/v6/mapped）是否必须拒绝。 */
export function isBlockedAddress(address) {
  const ip = String(address ?? '').trim();
  if (ip.length === 0) return true;
  const version = net.isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // ::ffff:127.0.0.1 这类映射地址
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIpv4(mapped[1]);
    return false;
  }
  return true; // 解析不出来的一律拒绝
}

/**
 * 校验一个远程媒体 URL。
 * @param {string} raw
 * @param {{ allowHosts?: string[]|null }} [options] - allowHosts 非空时只允许这些域名（含子域）
 * @returns {Promise<{ ok: boolean, url?: URL, addresses?: string[], error?: string }>}
 */
export async function assertSafeMediaUrl(raw, options = {}) {
  let url;
  try {
    url = new URL(String(raw ?? ''));
  } catch {
    return { ok: false, error: 'URL 解析失败' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, error: `仅允许 http/https，收到 ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'URL 不得内嵌用户名/密码' };
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return { ok: false, error: `禁止访问本机/内网域名：${hostname}` };
  }
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) return { ok: false, error: `禁止访问内网/保留地址：${hostname}` };
    return { ok: true, url, addresses: [hostname] };
  }
  const allowHosts = options.allowHosts;
  if (Array.isArray(allowHosts) && allowHosts.length > 0) {
    const allowed = allowHosts.some((entry) => {
      const value = String(entry).toLowerCase();
      return hostname === value || hostname.endsWith(`.${value}`);
    });
    if (!allowed) return { ok: false, error: `域名 ${hostname} 不在允许列表内` };
  }
  let addresses;
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    addresses = records.map((record) => record.address);
  } catch (error) {
    return { ok: false, error: `DNS 解析失败：${String(error?.message ?? error).slice(0, 120)}` };
  }
  if (addresses.length === 0) return { ok: false, error: 'DNS 未返回任何地址' };
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      return { ok: false, error: `域名 ${hostname} 解析到内网/保留地址 ${address}，已阻止` };
    }
  }
  return { ok: true, url, addresses };
}

import test from 'node:test';
import assert from 'node:assert/strict';

import { assertSafeMediaUrl, isBlockedAddress, isBlockedIpv4 } from '../../src/net-guard.js';

test('内网/环回/保留地址一律识别为阻断', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255']) {
    assert.equal(isBlockedIpv4(ip), true, `${ip} 应被阻断`);
    assert.equal(isBlockedAddress(ip), true, `${ip} 应被阻断`);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '223.5.5.5']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} 不应被阻断`);
  }
});

test('IPv6 环回、链路本地、ULA、以及映射的 v4 内网都阻断', () => {
  assert.equal(isBlockedAddress('::1'), true);
  assert.equal(isBlockedAddress('fe80::1'), true);
  assert.equal(isBlockedAddress('fc00::1'), true);
  assert.equal(isBlockedAddress('fd12:3456::1'), true);
  assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedAddress('2001:4860:4860::8888'), false);
});

test('非 http/https 协议被拒绝', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/a.mp4', 'javascript:alert(1)', 'data:video/mp4;base64,AAAA']) {
    const result = await assertSafeMediaUrl(url);
    assert.equal(result.ok, false, `${url} 应被拒绝`);
  }
});

test('本机/内网域名被拒绝', async () => {
  for (const url of ['http://localhost/a.mp4', 'http://foo.localhost/a.mp4', 'http://printer.local/a.mp4', 'http://x.internal/a.mp4']) {
    const result = await assertSafeMediaUrl(url);
    assert.equal(result.ok, false, `${url} 应被拒绝`);
    assert.match(result.error, /本机|内网/);
  }
});

test('直接给内网 IP 被拒绝，公网 IP 放行', async () => {
  const blocked = await assertSafeMediaUrl('http://192.168.1.10/video.mp4');
  assert.equal(blocked.ok, false);
  const allowed = await assertSafeMediaUrl('https://1.1.1.1/video.mp4');
  assert.equal(allowed.ok, true);
});

test('URL 内嵌用户名/密码被拒绝', async () => {
  const result = await assertSafeMediaUrl('https://user:pass@example.com/a.mp4');
  assert.equal(result.ok, false);
  assert.match(result.error, /用户名|密码/);
});

test('allowHosts 白名单：只允许指定域名及其子域', async () => {
  const denied = await assertSafeMediaUrl('https://evil.example.org/a.mp4', { allowHosts: ['bilibili.com'] });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /允许列表/);
});

test('非法 URL 返回错误而不是抛异常', async () => {
  const result = await assertSafeMediaUrl('not a url');
  assert.equal(result.ok, false);
  assert.match(result.error, /解析失败/);
});

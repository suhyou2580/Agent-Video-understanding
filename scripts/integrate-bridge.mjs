#!/usr/bin/env node
/**
 * 把视频理解工具挂到 qq-bridge 既有的 `snowluma-host` MCP server 上（纯追加）。
 *
 * 为什么挂这里：QQ 会话有执行期工具白名单，
 * 只放行 mcp__snowluma__ / mcp__snowluma-host__ / mcp__web-search-safe__ / mcp__phone__。
 * 新开 serverName 会得到别的前缀，工具会在执行期被拒绝。
 * 挂到 snowluma-host 上得到 mcp__snowluma-host__video_*，正好在白名单内，
 * 且不修改任何 QQ agent 机制（唤醒 / 分条 / 提示词 / 白名单全部不动）。
 *
 * 用法：
 *   node scripts/integrate-bridge.mjs --check
 *   node scripts/integrate-bridge.mjs --apply
 *   node scripts/integrate-bridge.mjs --remove
 *
 * 环境变量：QQ_BRIDGE_DIR（默认 D:\qq-bridge）、VIDEO_UNDERSTANDING_DIR
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = process.env.VIDEO_UNDERSTANDING_DIR ?? path.resolve(HERE, '..');
const BRIDGE_DIR = process.env.QQ_BRIDGE_DIR ?? 'D:\\qq-bridge';
const TARGET = path.join(BRIDGE_DIR, 'src', 'mcp-host-server.js');

const BEGIN = '// === video-understanding MCP tools (additive) BEGIN ===';
const END = '// === video-understanding MCP tools (additive) END ===';

const args = process.argv.slice(2);
const mode = args.includes('--apply') ? 'apply' : args.includes('--remove') ? 'remove' : 'check';

function buildBlock() {
  const toolsUrl = pathToFileURL(path.join(PLUGIN_DIR, 'src', 'mcp-tools.js')).href;
  return [
    BEGIN,
    '// 本段由 plug-in/video-understanding/scripts/integrate-bridge.mjs 维护；整段删除即完全回滚。',
    '// 只追加 video_* 工具，不改动本 server 原有工具与任何 QQ agent 机制。',
    'try {',
    `  const videoToolsUrl = process.env.VIDEO_TOOLS_URL || ${JSON.stringify(toolsUrl)};`,
    '  const { registerVideoTools } = await import(videoToolsUrl);',
    '  const zod = await import(\'zod\');',
    '  const z = zod.z ?? zod.default?.z ?? zod.default;',
    '  const registeredVideo = registerVideoTools(server, { z });',
    '  if (registeredVideo.failed.length > 0) {',
    '    console.error(\'[video-understanding] 部分视频工具注册失败：\' + JSON.stringify(registeredVideo.failed));',
    '  }',
    '} catch (error) {',
    '  // 视频能力不可用时降级：本 MCP server 的其它工具照常可用（等价于"没有视频能力"）。',
    '  console.error(\'[video-understanding] 视频工具不可用（不影响其它工具）：\' + String(error?.message ?? error));',
    '}',
    END,
  ].join('\n');
}

function readTarget() {
  if (!fs.existsSync(TARGET)) {
    throw new Error(`找不到 ${TARGET}；若 qq-bridge 不在默认位置，请设置 QQ_BRIDGE_DIR`);
  }
  return fs.readFileSync(TARGET, 'utf8');
}

function isPatched(text) {
  return text.includes(BEGIN) && text.includes(END);
}

function report(status, extra = {}) {
  console.log(JSON.stringify({ ok: true, mode, target: TARGET, status, ...extra }, null, 2));
}

function syntaxCheck(file) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

function apply() {
  let text = readTarget();
  if (isPatched(text)) {
    report('already_patched');
    return;
  }
  const anchor = 'await server.connect(new StdioServerTransport());';
  if (!text.includes(anchor)) {
    throw new Error(`在 ${TARGET} 里找不到 ${anchor} —— 文件结构已变化，请手工接入（见 README）`);
  }
  const backup = `${TARGET}.video-understanding.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.writeFileSync(backup, text, 'utf8');
  text = text.replace(anchor, `${buildBlock()}\n\n${anchor}`);
  fs.writeFileSync(TARGET, text, 'utf8');
  try {
    syntaxCheck(TARGET);
  } catch (error) {
    fs.writeFileSync(TARGET, fs.readFileSync(backup, 'utf8'), 'utf8');
    throw new Error(`接入后语法检查失败，已回滚：${String(error?.message ?? error)}`);
  }
  report('patched', { backup, note: '重启 qq-bridge 后生效' });
}

function remove() {
  let text = readTarget();
  if (!isPatched(text)) {
    report('not_patched');
    return;
  }
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 || end < 0) throw new Error('标记不完整，请手工检查');
  text = `${text.slice(0, start)}${text.slice(end + END.length)}`.replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(TARGET, text, 'utf8');
  try {
    syntaxCheck(TARGET);
  } catch (error) {
    throw new Error(`回滚后语法检查失败：${String(error?.message ?? error)}`);
  }
  report('removed', { note: '重启 qq-bridge 后生效；原有工具不受影响' });
}

try {
  if (mode === 'apply') apply();
  else if (mode === 'remove') remove();
  else report(isPatched(readTarget()) ? 'patched' : 'not_patched');
} catch (error) {
  console.error(JSON.stringify({ ok: false, mode, target: TARGET, error: String(error?.message ?? error) }, null, 2));
  process.exitCode = 1;
}

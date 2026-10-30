#!/usr/bin/env node
/**
 * 真实接入验证：用 stdio 直接和 qq-bridge 的 `snowluma-host` MCP server 说 MCP 协议，
 * 确认视频工具真的注册上、原有工具（含记忆工具）没被打坏，并能真的跑一次抽帧。
 *
 *   node scripts/verify-mcp.mjs
 *   node scripts/verify-mcp.mjs --selftest     # 额外用一张真实 GIF 跑 video_frames
 *
 * 这是"端到端接入验证"，不是单元测试：它跑的是 DSH 真正会 spawn 的那个进程。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { unevenDelayGif } from '../tests/fixtures/make-gif.mjs';

const BRIDGE_DIR = process.env.QQ_BRIDGE_DIR ?? 'D:\\qq-bridge';
const SERVER = path.join(BRIDGE_DIR, 'src', 'mcp-host-server.js');
const selfTest = process.argv.includes('--selftest');

const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, VIDEO_UNDERSTANDING_LOG_LEVEL: process.env.VIDEO_UNDERSTANDING_LOG_LEVEL ?? 'error' },
});

let buffer = '';
const pending = new Map();
let nextId = 1;
const stderrChunks = [];

child.stderr.on('data', (chunk) => stderrChunks.push(String(chunk)));

child.stdout.on('data', (chunk) => {
  buffer += String(chunk);
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 60000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
}

function parseBody(response) {
  const text = response.result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const out = { server: SERVER };
let tempDir = null;
try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'video-understanding-verify', version: '0.1.0' },
  });
  out.initialize = init.result?.serverInfo ?? null;
  notify('notifications/initialized');

  const listed = await request('tools/list', {});
  const tools = (listed.result?.tools ?? []).map((tool) => tool.name);
  out.tool_count = tools.length;
  out.video_tools = tools.filter((name) => name.includes('video_'));
  out.memory_tools = tools.filter((name) => name.includes('memory_'));
  out.original_tools = tools.filter((name) => name === 'snowluma_status');
  out.registered_ok = out.video_tools.length >= 6;
  out.memory_still_ok = out.memory_tools.length >= 8;
  out.original_tool_intact = out.original_tools.includes('snowluma_status');

  const doctor = await request('tools/call', { name: 'video_doctor', arguments: {} });
  out.doctor = { ok: !doctor.result?.isError, result: parseBody(doctor) };

  if (selfTest) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdu-mcp-'));
    const gif = path.join(tempDir, 'probe.gif');
    fs.writeFileSync(gif, unevenDelayGif());
    const started = Date.now();
    const frames = await request('tools/call', {
      name: 'video_frames',
      arguments: { source_path: gif, count: 4 },
    });
    const content = frames.result?.content ?? [];
    const images = content.filter((block) => block.type === 'image');
    const text = content.find((block) => block.type === 'text')?.text ?? '';
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    out.selftest = {
      ok: !frames.result?.isError && images.length >= 3,
      image_blocks: images.length,
      bytes_each: images.map((image) => Buffer.from(image.data, 'base64').length),
      elapsed_ms: Date.now() - started,
      text_head: typeof text === 'string' ? text.slice(0, 400) : null,
      task_id: typeof body?.task_id === 'string' ? body.task_id : null,
    };
  }

  out.ok = out.registered_ok && out.original_tool_intact && out.memory_still_ok;
} catch (error) {
  out.ok = false;
  out.error = String(error?.message ?? error);
} finally {
  try {
    child.stdin.end();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }, 100);
}

console.log(JSON.stringify(out, null, 2));
if (stderrChunks.join('').trim().length > 0) {
  console.log('\n--- server stderr ---');
  console.log(stderrChunks.join('').trim().slice(0, 2000));
}
if (tempDir) {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
if (!out.ok) process.exitCode = 1;

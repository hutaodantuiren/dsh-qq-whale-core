#!/usr/bin/env node
/**
 * 只读联网 MCP server（serverName: web-search-safe）。
 * 与 qq-bridge 的同名工具保持兼容：web_search / web_fetch。
 * 这样角色卡里的 mcp__web-search-safe__web_search 可以直接使用。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HOME = process.env.QQ_BRIDGE_HOME || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_FILE = path.join(HOME, 'state', 'runtime.json');

const TOOLS = [
  {
    name: 'web_search',
    description: '联网搜索（Bing / DuckDuckGo），返回标题、链接、摘要。只读，不需要 QQ 会话令牌。',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] },
  },
  {
    name: 'web_fetch',
    description: '抓取公网 URL 的正文（带 SSRF 防护，只允许 http/https 公网地址）。只读。',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: '要抓取的 URL' } }, required: ['url'] },
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadRuntime() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const data = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
      if (data?.url && data?.token) return data;
    } catch {
      /* wait */
    }
    await sleep(300);
  }
  throw new Error(`桥接尚未启动或 runtime.json 不可读：${RUNTIME_FILE}`);
}

const runtime = await loadRuntime().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});

async function rpc(method, params) {
  const res = await fetch(`${runtime.url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': runtime.token },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '桥接返回失败');
  return data.result;
}

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg.method || msg.id === undefined) return;
  try {
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'web-search-safe', version: '0.1.0' },
          instructions: '只读联网搜索/抓取。web_search 返回搜索结果，web_fetch 读取正文；不要用它访问内网。',
        },
      });
    } else if (msg.method === 'notifications/initialized') {
      /* no-op */
    } else if (msg.method === 'ping') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      if (!TOOLS.some((tool) => tool.name === name)) throw new Error(`未知工具：${name}`);
      const result = await rpc(`tool.${name}`, args);
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: text.slice(0, 20000) }] } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  } catch (error) {
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `工具执行失败：${error.message}` }], isError: true } });
  }
});

process.stdin.on('end', () => process.exit(0));

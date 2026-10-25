#!/usr/bin/env node
/**
 * 环境自检：配置 / DSH / SnowLuma / MCP / 余额。
 * 用法：node scripts/doctor.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const results = [];
let failed = 0;

function ok(name, detail = '') {
  results.push({ name, ok: true, detail });
}
function warn(name, detail = '') {
  results.push({ name, ok: true, warn: true, detail });
}
function bad(name, detail = '') {
  results.push({ name, ok: false, detail });
  failed += 1;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function checkSnowluma(config) {
  const httpUrl = String(config.snowluma?.httpUrl || '').replace(/\/+$/, '');
  if (!httpUrl) {
    bad('SnowLuma HTTP 地址', '未配置');
    return;
  }
  try {
    const res = await fetch(`${httpUrl}/get_login_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...((config.snowluma.httpToken || config.snowluma.accessToken) ? { authorization: `${config.snowluma.authPrefix || 'Bearer'} ${config.snowluma.httpToken || config.snowluma.accessToken}` } : {}) },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (data?.status === 'ok' || data?.retcode === 0) ok('SnowLuma HTTP', `${data.data?.nickname || '已登录'} (${data.data?.user_id || '?'})`);
    else bad('SnowLuma HTTP', data?.message || data?.wording || `HTTP ${res.status}`);
  } catch (error) {
    bad('SnowLuma HTTP', error.message);
  }

  const wsUrl = config.snowluma?.wsUrl;
  if (!wsUrl) {
    warn('SnowLuma WebSocket', '未配置（没有事件推送，桥接无法收消息）');
    return;
  }
  await new Promise((resolve) => {
    let done = false;
    const finish = (fn, detail) => {
      if (done) return;
      done = true;
      fn('SnowLuma WebSocket', detail);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve();
    };
    let ws;
    try {
      const sep = wsUrl.includes('?') ? '&' : '?';
      const wsToken = config.snowluma.wsToken || config.snowluma.accessToken;
      ws = new WebSocket(wsToken ? `${wsUrl}${sep}access_token=${encodeURIComponent(wsToken)}` : wsUrl);
    } catch (error) {
      finish(bad, error.message);
      return;
    }
    const timer = setTimeout(() => finish(bad, '连接超时（5 秒）'), 5000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      finish(ok, wsUrl);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      finish(bad, '无法连接（端口/令牌/SnowLuma 是否开启 WS 服务端？）');
    });
  });
}

function checkDsh(config) {
  const command = config.dsh?.command || '';
  if (!command) {
    bad('DSH 命令', '未配置');
    return;
  }
  if (!fs.existsSync(command) && command !== 'dsh') {
    bad('DSH 命令', `不存在：${command}`);
    return;
  }
  const isCmd = /\.(cmd|bat)$/i.test(command);
  const args = isCmd ? ['/d', '/c', 'call', command, '--profile', config.dsh.profile || 'sdk', '--dump-config'] : ['--profile', config.dsh.profile || 'sdk', '--dump-config'];
  const result = spawnSync(isCmd ? process.env.ComSpec || 'cmd.exe' : command, args, { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (result.status === 0) ok('DSH SDK profile', `${config.dsh.profile || 'sdk'} 可用`);
  else bad('DSH SDK profile', (result.stderr || result.stdout || '').slice(-300));
}

function checkPatch(config) {
  const patch = config.paths?.patch || path.join(ROOT, 'dsh', 'qq.patch.generated.yml');
  if (!fs.existsSync(patch)) {
    bad('DSH patch', `不存在：${patch}（先运行 node scripts/setup.mjs）`);
    return;
  }
  const text = fs.readFileSync(patch, 'utf8');
  if (!text.includes('mcp-qq')) bad('DSH patch', '缺少 mcp-qq 行');
  else if (!text.includes('mcp-server.js')) bad('DSH patch', '缺少 MCP server 路径');
  else ok('DSH patch', patch);
  const workspace = config.paths?.workspace || path.join(ROOT, 'workspace');
  if (fs.existsSync(path.join(workspace, 'AGENTS.md'))) ok('人格工作区', path.join(workspace, 'AGENTS.md'));
  else bad('人格工作区', '缺少 AGENTS.md（运行 setup.mjs）');
}

async function checkMcp(config) {
  const runtimeFile = path.join(ROOT, 'state', 'runtime.json');
  if (!fs.existsSync(runtimeFile)) {
    warn('QQ MCP', '桥接未运行（state/runtime.json 不存在），启动桥接后再测');
    return;
  }
  try {
    const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    const health = await fetch(`${runtime.url}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) throw new Error(`health HTTP ${health.status}`);
  } catch (error) {
    warn('QQ MCP', `桥接控制面不可用：${error.message}`);
    return;
  }
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp-server.js')], {
      env: { ...process.env, QQ_BRIDGE_HOME: ROOT },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let done = false;
    const finish = (fn, detail) => {
      if (done) return;
      done = true;
      fn('QQ MCP', detail);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve();
    };
    const timer = setTimeout(() => finish(bad, 'MCP 握手超时'), 8000);
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 1 && msg.result) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
      }
      if (msg.id === 2 && msg.result) {
        clearTimeout(timer);
        finish(ok, `${msg.result.tools?.length || 0} 个工具`);
      }
    });
    child.on('exit', () => finish(bad, 'MCP 进程提前退出'));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'doctor', version: '1' } } })}\n`);
  });
}

function checkBalance(config) {
  const file = config.balance?.usageFile || path.join(os.homedir(), '.dsh', '.dshw-usage.json');
  const data = readJson(file, null);
  if (!data) warn('DSH 余额缓存', `读不到 ${file}（余额工具会返回未知）`);
  else ok('DSH 余额缓存', `¥${Number(data.lastBalance).toFixed(2)} · 今日 ¥${Number(data.todayUsage || 0).toFixed(2)}`);
}

async function main() {
  console.log('🐳 DeepSeek 小鲸鱼 QQ 桥接 · 自检\n');
  const configFile = path.join(ROOT, 'config.json');
  if (!fs.existsSync(configFile)) {
    console.error(`✗ 缺少 ${configFile}，请先运行 node scripts/setup.mjs`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (!config.dsh) config.dsh = {};
  if (!config.dsh.command) {
    const found = [
      'E:/code/deepseekharness/resources/runtime/cli/bin/dsh.cmd',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    ].find((candidate) => fs.existsSync(candidate));
    if (found) config.dsh.command = found;
  }
  config.paths = {
    patch: config.dsh?.patch ? path.resolve(ROOT, config.dsh.patch) : path.join(ROOT, 'dsh', 'qq.patch.generated.yml'),
    workspace: config.dsh?.workspace ? path.resolve(ROOT, config.dsh.workspace) : path.join(ROOT, 'workspace'),
  };

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) ok('Node.js', process.versions.node);
  else bad('Node.js', `${process.versions.node}（需要 >= 22.13）`);

  const allowGroups = config.qq?.allow?.groups || [];
  const allowPrivate = config.qq?.allow?.private || [];
  if (!allowGroups.length && !allowPrivate.length && !config.qq?.allowAllWhenEmpty) {
    warn('白名单', '为空且 allowAllWhenEmpty=false：不会响应任何消息');
  } else {
    ok('白名单', `${allowGroups.length} 群 / ${allowPrivate.length} 私聊`);
  }

  if (config.voice?.enabled) {
    if (config.voice.command) ok('语音转写', `本地命令 ${config.voice.command}`);
    else if (config.voice.apiUrl) ok('语音转写', `API ${config.voice.apiUrl}`);
    else if (process.platform === 'win32') ok('语音转写', `Windows 内置 ${config.voice.language || 'zh-CN'} 识别（准确率一般，可换 whisper）`);
    else warn('语音转写', '未配置 voice.command / voice.apiUrl');
  }
  if (config.archive?.enabled) {
    const dir = path.resolve(ROOT, config.archive.dir || 'state/archive');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      ok('归档目录', dir);
    } catch (error) {
      bad('归档目录', error.message);
    }
  }
  if (config.diary?.enabled) {
    try {
      fs.mkdirSync(path.join(ROOT, 'workspace', 'diary'), { recursive: true });
      ok('日记目录', path.join(ROOT, 'workspace', 'diary'));
    } catch (error) {
      warn('日记目录', error.message);
    }
  }

  checkDsh(config);
  checkPatch(config);
  checkBalance(config);
  await checkSnowluma(config);
  await checkMcp(config);

  console.log('');
  for (const item of results) {
    const mark = item.ok ? (item.warn ? '⚠' : '✓') : '✗';
    console.log(`${mark} ${item.name}${item.detail ? `：${item.detail}` : ''}`);
  }
  console.log('');
  if (failed) {
    console.log(`有 ${failed} 项失败。先修好再启动桥接。`);
    process.exit(1);
  }
  console.log('全部关键项通过。可以运行 start-qq-bridge.cmd。');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

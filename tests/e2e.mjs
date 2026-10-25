/**
 * 端到端自测：假 OneBot HTTP 服务 + 真 DSH SDK + 真桥接。
 * 不连接真实 QQ；会消耗少量模型 token。
 * 用法：node tests/e2e.mjs [--keep]
 */
import http from 'node:http';
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { Bridge } from '../src/bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const PORT = 3901;
const sent = [];

function json(res, data) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const action = url.pathname.replace(/^\//, '');
  let body = '';
  for await (const chunk of req) body += chunk;
  let params = {};
  try { params = JSON.parse(body || '{}'); } catch { /* ignore */ }
  if (action === 'get_login_info') return json(res, { status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '小鲸鱼' } });
  if (action === 'get_status') return json(res, { status: 'ok', retcode: 0, data: { online: true, good: true } });
  if (action === 'get_group_info') return json(res, { status: 'ok', retcode: 0, data: { group_id: 123456, group_name: '鲸鱼测试群', member_count: 2 } });
  if (action === 'get_group_member_info') {
    const self = Number(params.user_id) === 10001;
    return json(res, {
      status: 'ok', retcode: 0,
      data: { user_id: params.user_id, nickname: self ? '小鲸鱼' : '群友A', card: self ? '小鲸鱼' : '群友A', role: self ? 'admin' : 'member' },
    });
  }
  if (action === 'get_group_member_list') {
    return json(res, {
      status: 'ok', retcode: 0,
      data: [
        { user_id: 10001, nickname: '小鲸鱼', card: '小鲸鱼', role: 'admin' },
        { user_id: 20001, nickname: '群友A', card: '群友A', role: 'member' },
      ],
    });
  }
  if (action === 'send_group_msg' || action === 'send_private_msg') {
    const segs = params.message || [];
    const text = segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('');
    sent.push({ action, text, messageId: String(42000 + sent.length + 1), params });
    return json(res, { status: 'ok', retcode: 0, data: { message_id: 42000 + sent.length } });
  }
  if (action === 'delete_msg') return json(res, { status: 'ok', retcode: 0, data: null });
  if (action === 'set_group_ban') return json(res, { status: 'ok', retcode: 0, data: null });
  if (action === 'get_msg') return json(res, { status: 'ok', retcode: 0, data: { message_id: params.message_id, message: [] } });
  return json(res, { status: 'ok', retcode: 0, data: null });
});

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`等待超时：${label}`);
}

async function main() {
  await new Promise((resolve) => mock.listen(PORT, '127.0.0.1', resolve));
  const config = loadConfig();
  config.bridge.port = 3999;
  config.bridge.token = 'test-token';
  config.snowluma.httpUrl = `http://127.0.0.1:${PORT}`;
  config.snowluma.wsUrl = '';
  config.qq.allowAllWhenEmpty = true;
  config.qq.allow.groups = ['123456'];
  config.chat.batchWindowMs = 300;
  config.wake.defaultMode = 'active';
  config.dsh.reasoningEffort = 'low';
  config.dsh.maxTokens = 768;
  config.dsh.turnTimeoutMs = 240000;
  config.admin.autoSelfRecall.enabled = false;
  config.proactive.enabled = false;
  config.diary.enabled = false;
  config.archive.enabled = false;
  config.slang.autoLearn.enabled = false;
  config.voice.autoTranscribe = false;
  config.forward.autoExpand = false;
  config.dsh.patch = path.join(ROOT, 'dsh', 'qq.patch.generated.yml');
  config.dsh.workspace = path.join(ROOT, 'workspace');

  for (const file of ['state/state.json']) fs.rmSync(path.join(ROOT, file), { force: true });
  fs.rmSync(path.join(ROOT, 'state/memory'), { recursive: true, force: true });

  const log = new Logger({ level: 'info' });
  const bridge = new Bridge(config, log);
  await bridge.start();
  console.log('等待 DSH SDK 就绪…');
  await waitFor(() => bridge.dshReady, 120000, 'DSH SDK ready');
  console.log('DSH 已就绪，注入一条 @ 消息…');

  const preChat = bridge.getChat({ chatType: 'group', groupId: 123456, groupName: '鲸鱼测试群' });
  preChat.sessionId = `session-qq-test-${Date.now()}`;

  await bridge.handleEvent({
    kind: 'message',
    self: false,
    chatType: 'group',
    groupId: 123456,
    groupName: '鲸鱼测试群',
    userId: 20001,
    messageId: 'test-msg-1',
    time: Date.now(),
    sender: { userId: 20001, nickname: '群友A', card: '群友A', role: 'member' },
    segments: [
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: ' 小鲸鱼你在吗？用一句很短的话回我，别调用等待工具。' } },
    ],
    text: ' 小鲸鱼你在吗？用一句很短的话回我，别调用等待工具。',
    ats: ['10001'],
    replyId: '',
    images: [],
  });

  await waitFor(() => sent.length > 0, 180000, 'QQ 回复');
  console.log('\n收到回复：');
  for (const item of sent) console.log(`  -> ${item.text}`);
  const chat = bridge.chats.get('group:123456');
  console.log('\n大肥鱼硬唤醒检查：');
  const beforeGrudge = sent.length;
  await bridge.handleEvent({
    kind: 'message', self: false, chatType: 'group', groupId: 123456, groupName: '鲸鱼测试群',
    userId: 20001, messageId: 'test-grudge-1', time: Date.now(),
    sender: { userId: 20001, nickname: '群友A', card: '群友A', role: 'member' },
    segments: [{ type: 'text', data: { text: '蓝色大肥鱼！' } }],
    text: '蓝色大肥鱼！', ats: [], replyId: '', images: [],
  });
  await waitFor(() => sent.length > beforeGrudge, 180000, '大肥鱼回复');
  await waitFor(() => chat.lastThinking?.grudge, 180000, '大肥鱼思考记录');
  console.log('  grudge reply =', sent[sent.length - 1].text);
  console.log('  grudge thinking =', !!chat.lastThinking?.grudge, (chat.lastThinking?.text || '').slice(0, 40));
  console.log('  grudge trace =', (chat.lastThinking?.trace || '').split('\n').slice(0, 5).join(' | '));
  console.log('  social after =', chat.social?.state);

  console.log('\n管理能力检查：');
  const admin = await bridge.toolAdminStatus({ token: chat.token });
  console.log('  admin_status =', JSON.stringify(admin));
  const muted = await bridge.toolMuteMember({ token: chat.token, userId: '20001', durationSeconds: 60, reason: '测试', taunt: '安静点' });
  console.log('  mute =', JSON.stringify(muted));
  const recalled = await bridge.toolRecallMessage({ token: chat.token, messageId: 'test-msg-1' });
  console.log('  recall =', JSON.stringify(recalled));
  const wake = bridge.toolSetWakeConfig({ token: chat.token, config: { mode: 'diving', sleepMinutes: 5 } });
  console.log('  wake =', wake.text);
  const balance = bridge.toolBalance({ token: chat.token });
  console.log('  balance =', balance.text);
  const rel = bridge.toolRelationGet({ token: chat.token });
  console.log('  relations =', (rel.list || []).length);
  const arch = bridge.toolArchiveStats({ token: chat.token });
  console.log('  archive =', arch.chat?.total || 0, arch.global.total);
  const diary = bridge.toolDiaryRead({ token: chat.token });
  console.log('  diary list =', (diary.list || []).length);

  console.log('\nowner agent 模式检查：');
  const beforeOwner = sent.length;
  await bridge.handleEvent({
    kind: 'message', self: false, chatType: 'private', groupId: 0, groupName: '',
    userId: Number(bridge.config.qq.ownerQQ || 3351107931), messageId: 'test-owner-1', time: Date.now(),
    sender: { userId: Number(bridge.config.qq.ownerQQ || 3351107931), nickname: '主人', card: '', role: 'member' },
    segments: [{ type: 'text', data: { text: '只回复一个词：owner-ok。不要调用任何工具。' } }],
    text: '只回复一个词：owner-ok。不要调用任何工具。', ats: [], replyId: '', images: [],
  });
  await waitFor(() => sent.length > beforeOwner, 180000, 'owner 回复');
  console.log('  owner reply =', sent[sent.length - 1].text);
  console.log('  owner ready =', bridge.ownerDshReady, '| session =', bridge.chats.get(`private:${bridge.config.qq.ownerQQ}`)?.ownerSessionId);

  console.log('\nMCP 握手检查：');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp-server.js')], {
      env: { ...process.env, QQ_BRIDGE_HOME: ROOT },
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    });
    const rl = readline.createInterface({ input: child.stdout });
    let tools = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP 超时'));
    }, 10000);
    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 1) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
      if (msg.id === 2) {
        tools = msg.result.tools.length;
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_message', arguments: { token: chat.token, messages: ['MCP发送测试'] } } })}\n`);
      }
      if (msg.id === 3) {
        console.log('  tools =', tools, '| send_message =', (msg.result.content?.[0]?.text || '').slice(0, 50).replace(/\n/g, ' '));
        if (!sent.some((item) => item.text.includes('MCP发送测试'))) throw new Error('MCP send_message 没有到达 OneBot');
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'balance', arguments: { token: chat.token } } })}\n`);
      }
      if (msg.id === 4) {
        console.log('  balance =', (msg.result.content?.[0]?.text || '').slice(0, 50).replace(/\n/g, ' '));
        clearTimeout(timer);
        child.kill();
        resolve();
      }
    });
    child.on('error', reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } })}\n`);
  });

  if (!KEEP) {
    await bridge.stop().catch(() => {});
    mock.close();
    process.exit(0);
  }
}

main().catch(async (error) => {
  console.error('E2E 失败：', error.stack || error.message);
  try { mock.close(); } catch { /* ignore */ }
  process.exit(1);
});

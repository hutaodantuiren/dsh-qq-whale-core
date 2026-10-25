import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomToken } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOOL_METHODS = {
  send_message: 'toolSendMessage',
  reply: 'toolReply',
  wait_messages: 'toolWaitMessages',
  mark_read: 'toolMarkRead',
  set_wake_config: 'toolSetWakeConfig',
  get_members: 'toolGetMembers',
  get_active_members: 'toolGetActiveMembers',
  get_message_detail: 'toolGetMessageDetail',
  memory_append: 'toolMemoryAppend',
  memory_query: 'toolMemoryQuery',
  memory_remove: 'toolMemoryRemove',
  memory_clear: 'toolMemoryClear',
  slang_query: 'toolSlangQuery',
  slang_submit: 'toolSlangSubmit',
  slang_list: 'toolSlangList',
  balance: 'toolBalance',
  admin_status: 'toolAdminStatus',
  recall_message: 'toolRecallMessage',
  recall_last_self: 'toolRecallLastSelf',
  mute_member: 'toolMuteMember',
  kick_member: 'toolKickMember',
  send_poke: 'toolSendPoke',
  find_avatar: 'toolFindAvatar',
  set_avatar: 'toolSetAvatar',
  send_image: 'toolSendImage',
  collect_sticker: 'toolCollectSticker',
  list_stickers: 'toolListStickers',
  sticker_note: 'toolStickerNote',
  send_sticker: 'toolSendSticker',
  sticker_ban: 'toolStickerBan',
  get_images: 'toolGetImages',
  get_forward_msg: 'toolGetForwardMsg',
  transcribe_voice: 'toolTranscribeVoice',
  relation_get: 'toolRelationGet',
  relation_set: 'toolRelationSet',
  diary_read: 'toolDiaryRead',
  archive_list: 'toolArchiveList',
  archive_stats: 'toolArchiveStats',
  web_search: 'toolWebSearch',
  web_fetch: 'toolWebFetch',
  read_website: 'toolReadWebsite',
  play_song: 'toolPlaySong',
  play_video: 'toolPlayVideo',
  set_nickname: 'toolSetNickname',
};

export class ControlServer {
  constructor({ bridge, config, log }) {
    this.bridge = bridge;
    this.config = config;
    this.log = log;
    this.server = null;
    this.token = config.bridge.token;
    this.host = config.bridge.host || '127.0.0.1';
    this.port = Number(config.bridge.port) || 3210;
    this.url = `http://${this.host}:${this.port}`;
    this.startedAt = Date.now();
  }

  async start() {
    if (!this.token) {
      this.token = randomToken(16);
      this.config.bridge.token = this.token;
      fs.writeFileSync(path.join(this.config.paths.state, 'bridge-token'), this.token, 'utf8');
      this.log.warn(`已生成控制台令牌并写入 state/bridge-token：${this.token}`);
    }
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.log.error(`控制台请求失败：${error.stack || error.message}`);
        if (!res.headersSent) this.sendJson(res, 500, { ok: false, error: error.message });
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => resolve());
    });
    this.log.info(`控制台已启动：${this.url}/?token=${this.token}`);
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  authorized(req, url) {
    const supplied = req.headers['x-bridge-token'] || url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!supplied || !this.token) return false;
    const a = Buffer.from(String(supplied));
    const b = Buffer.from(String(this.token));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  async readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async handle(req, res) {
    const url = new URL(req.url, this.url);
    if (url.pathname === '/health') {
      this.sendJson(res, 200, { ok: true, uptimeMs: Date.now() - this.startedAt });
      return;
    }
    if (!this.authorized(req, url)) {
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><body style="font-family:system-ui;background:#10131a;color:#dbe4ff;padding:40px"><h2>需要访问令牌</h2><p>请使用启动日志里打印的地址，或输入令牌：</p><script>const t=prompt("请输入控制台令牌");if(t)location.href="/?token="+encodeURIComponent(t);</script></body>');
        return;
      }
      this.sendJson(res, 401, { ok: false, error: '未授权：请提供 token' });
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/console')) {
      const file = path.join(__dirname, 'console.html');
      const html = fs.readFileSync(file, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      this.sendJson(res, 200, { ok: true, result: this.bridge.toolStatus() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = () => {
        try {
          res.write(`data: ${JSON.stringify(this.bridge.toolStatus())}\n\n`);
        } catch {
          /* ignore */
        }
      };
      send();
      const timer = setInterval(send, 5000);
      const unsubscribe = this.bridge.log.subscribe((entry) => {
        try {
          res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
        } catch {
          /* ignore */
        }
      });
      req.on('close', () => {
        clearInterval(timer);
        unsubscribe();
      });
      return;
    }

    if (req.method !== 'POST' || url.pathname !== '/rpc') {
      this.sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }

    const body = await this.readBody(req);
    const method = String(body.method || '');
    const params = body.params || {};
    try {
      const result = await this.dispatch(method, params);
      this.sendJson(res, 200, { ok: true, result });
    } catch (error) {
      this.log.warn(`RPC ${method} 失败：${error.message}`);
      this.sendJson(res, 200, { ok: false, error: error.message });
    }
  }

  async dispatch(method, params) {
    if (method.startsWith('tool.')) {
      const name = method.slice(5);
      const handler = TOOL_METHODS[name];
      if (!handler || typeof this.bridge[handler] !== 'function') throw new Error(`未知工具：${name}`);
      const started = Date.now();
      this.bridge.noteToolCall(name, params);
      try {
        const result = await this.bridge[handler](params);
        this.bridge.recordAudit({ tool: name, ok: true, ms: Date.now() - started, params: summarize(params) });
        return result;
      } catch (error) {
        this.bridge.recordAudit({ tool: name, ok: false, ms: Date.now() - started, params: summarize(params), error: error.message });
        throw error;
      }
    }
    switch (method) {
      case 'status':
        return this.bridge.toolStatus();
      case 'chats':
        return this.bridge.toolChats();
      case 'sticker.list':
        return this.bridge.stickerList(params.limit || 50);
      case 'sticker.hunt':
        return this.bridge.stickerHuntNow();
      case 'sticker.recognize':
        return this.bridge.stickerRecognize(params.id);
      case 'sticker.disable':
        return this.bridge.stickerSetDisabled(params.id, true);
      case 'sticker.enable':
        return this.bridge.stickerSetDisabled(params.id, false);
      case 'avatar.get':
        return this.bridge.toolStatus().extensions?.avatar || null;
      case 'avatar.change':
        return this.bridge.avatarChangeNow();
      case 'whitelist.get':
        return this.bridge.whitelistInfo();
      case 'whitelist.add':
        return this.bridge.addWhitelist(params.kind, params.id);
      case 'whitelist.remove':
        return this.bridge.removeWhitelist(params.kind, params.id);
      case 'usage':
        return { ...this.bridge.usage.summary(), events: this.bridge.usage.data.events.slice(-300), today: Number(this.bridge.usage.costToday().toFixed(4)) };
      case 'usage.detail':
        return { ...this.bridge.usage.summary(), events: this.bridge.usage.data.events.slice(-500), today: Number(this.bridge.usage.costToday().toFixed(4)) };
      case 'audit.list':
        return { entries: this.bridge.audit.slice(-(params.limit || 100)).reverse() };
      case 'prompts.get':
        return this.getPrompts();
      case 'prompts.set':
        return this.setPrompts(params);
      case 'diary.list':
        return { list: this.bridge.diary.listRecent(14) };
      case 'diary.generate':
        return this.bridge.runDiary(params.date || today());
      case 'relations.list':
        return this.bridge.toolRelationGet({ token: params.token });
      case 'archive.stats':
        return this.bridge.toolArchiveStats({ token: params.token });
      case 'proactive.trigger':
        await this.bridge.checkProactive();
        return { ok: true };
      case 'logs':
        return { logs: this.bridge.log.tail(params.limit || 100) };
      case 'session.reset':
        return this.bridge.toolResetSession(params);
      case 'chat.set_wake':
        return this.bridge.toolSetChatWake(params);
      case 'chat.send_test':
        return this.bridge.toolSendTest(params);
      case 'ping':
        return { ok: true, now: Date.now() };
      default:
        throw new Error(`未知方法：${method}`);
    }
  }

  getPrompts() {
    const dir = path.join(this.config.paths.workspace, 'prompts');
    const read = (name) => {
      try {
        return fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        return '';
      }
    };
    return { roleCard: read('role-card.md'), simulation: read('simulation.md'), system: read('system.md') };
  }

  async setPrompts({ file, content }) {
    const allowed = { 'role-card.md': 'roleCard', 'simulation.md': 'simulation', 'system.md': 'system' };
    if (!allowed[file]) throw new Error('只允许编辑 role-card.md / simulation.md / system.md');
    if (typeof content !== 'string' || content.length > 200000) throw new Error('内容为空或过大');
    const target = path.join(this.config.paths.workspace, 'prompts', file);
    fs.writeFileSync(target, content, 'utf8');
    const root = this.config.paths.root;
    const setup = spawnSync(process.execPath, [path.join(root, 'scripts', 'setup.mjs'), '--check'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });
    const restarted = await this.bridge.restartDsh();
    const reset = this.bridge.resetAllSessions();
    this.log.info(`人格文件已更新：${file}，DSH 重启=${restarted}，已重置 ${reset} 个会话`);
    return { ok: true, file, setup: (setup.stdout || '').slice(-1000), reset, restarted };
  }
}

function summarize(params) {
  try {
    const clone = { ...params };
    if (clone.token) clone.token = `${String(clone.token).slice(0, 4)}…`;
    if (clone.messages) clone.messages = Array.isArray(clone.messages) ? clone.messages.map((m) => String(m).slice(0, 40)).slice(0, 3) : String(clone.messages).slice(0, 80);
    const text = JSON.stringify(clone);
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return '';
  }
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

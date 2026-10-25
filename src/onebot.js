import { EventEmitter } from 'node:events';
import { sleep, truncate } from './util.js';

const WS_OPEN = 1;

/**
 * OneBot v11 客户端（SnowLuma）。
 * - HTTP API 用于动作调用；
 * - WebSocket 用于事件订阅（可带 access_token 查询参数）。
 */
export class OneBot extends EventEmitter {
  constructor(config, log) {
    super();
    this.config = config;
    this.log = log;
    this.httpUrl = String(config.httpUrl || '').replace(/\/+$/, '');
    this.wsUrl = String(config.wsUrl || '');
    this.token = config.accessToken || '';
    this.httpToken = config.httpToken || this.token;
    this.wsToken = config.wsToken || this.token;
    this.headers = config.headers || {};
    this.ws = null;
    this.closed = false;
    this.connected = false;
    this.selfId = null;
    this.nickname = '';
    this.reconnectDelay = config.reconnectMinMs ?? 1000;
    this.heartbeatTimer = null;
    this.heartbeatFails = 0;
    this.stats = { events: 0, calls: 0, errors: 0, lastEventAt: 0, lastCallAt: 0 };
  }

  authHeaders(extra = {}) {
    const headers = { ...this.headers, ...extra };
    if (this.httpToken) headers.Authorization = `${this.config.authPrefix || 'Bearer'} ${this.httpToken}`;
    return headers;
  }

  async call(action, params = {}, { timeoutMs = 20000 } = {}) {
    if (!this.httpUrl) throw new Error('未配置 SnowLuma HTTP API 地址');
    const url = `${this.httpUrl}/${action}`;
    const started = Date.now();
    this.stats.calls += 1;
    this.stats.lastCallAt = started;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`OneBot ${action} 返回非 JSON（HTTP ${response.status}）：${truncate(text, 200)}`);
      }
      if (!response.ok || (data.status && data.status !== 'ok') || (data.retcode !== undefined && data.retcode !== 0)) {
        const message = data.message || data.wording || data.msg || `HTTP ${response.status}`;
        const error = new Error(`OneBot ${action} 失败：${message}`);
        error.retcode = data.retcode;
        error.action = action;
        throw error;
      }
      return data.data;
    } catch (error) {
      this.stats.errors += 1;
      throw error;
    }
  }

  async start() {
    this.closed = false;
    await this.connect();
    await this.refreshSelf();
    this.startHeartbeat();
  }

  async refreshSelf() {
    try {
      const info = await this.call('get_login_info');
      if (info) {
        this.selfId = Number(info.user_id);
        this.nickname = info.nickname || `QQ${this.selfId}`;
        this.emit('self', { userId: this.selfId, nickname: this.nickname });
      }
    } catch (error) {
      this.log.warn(`get_login_info 失败：${error.message}`);
    }
    return { userId: this.selfId, nickname: this.nickname };
  }

  connect() {
    if (!this.wsUrl) return Promise.resolve();
    return new Promise((resolve) => {
      const sep = this.wsUrl.includes('?') ? '&' : '?';
      const url = this.wsToken ? `${this.wsUrl}${sep}access_token=${encodeURIComponent(this.wsToken)}` : this.wsUrl;
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (error) {
        this.log.error(`WebSocket 创建失败：${error.message}`);
        resolve();
        return;
      }
      this.ws = ws;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.log.warn('SnowLuma WebSocket 连接超时（5 秒）');
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          resolve();
        }
      }, 5000);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        this.connected = true;
        this.reconnectDelay = this.config.reconnectMinMs ?? 1000;
        this.heartbeatFails = 0;
        this.log.info(`SnowLuma 已连接：${this.wsUrl}`);
        this.emit('open');
        // 断线重连后 SnowLuma 可能才真正登录好，补一次自身信息，否则 selfId 一直是 null。
        this.refreshSelf().catch(() => {});
        resolve();
      });

      ws.addEventListener('message', (event) => {
        this.handleWsMessage(event.data);
      });

      ws.addEventListener('close', () => {
        clearTimeout(timer);
        const wasConnected = this.connected;
        this.connected = false;
        this.emit('close');
        if (!settled) {
          settled = true;
          resolve();
        }
        if (wasConnected) this.log.warn('SnowLuma WebSocket 已断开');
        this.scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        // close 事件会跟进，这里只避免未处理错误。
      });
    });
  }

  scheduleReconnect() {
    if (this.closed) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.config.reconnectMaxMs ?? 30000, Math.max(1000, this.reconnectDelay * 2));
    this.log.info(`${Math.round(delay / 1000)} 秒后重连 SnowLuma…`);
    setTimeout(() => {
      if (this.closed) return;
      this.connect();
    }, delay).unref?.();
  }

  handleWsMessage(raw) {
    let evt;
    try {
      evt = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }
    if (!evt || typeof evt !== 'object') return;
    this.stats.events += 1;
    this.stats.lastEventAt = Date.now();
    if (evt.post_type === 'meta_event') {
      if (evt.meta_event_type === 'lifecycle' && evt.sub_type === 'connect') {
        this.log.info('SnowLuma lifecycle connect');
      }
      return;
    }
    const normalized = this.normalizeEvent(evt);
    if (normalized) this.emit('event', normalized);
    else this.emit('raw-event', evt);
  }

  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.call('get_status', {}, { timeoutMs: 8000 });
        this.heartbeatFails = 0;
      } catch {
        this.heartbeatFails += 1;
        if (this.heartbeatFails >= 3 && this.ws) {
          this.log.warn('SnowLuma 心跳连续失败，重建 WebSocket');
          try {
            this.ws.close();
          } catch {
            /* ignore */
          }
        }
      }
    }, 30000);
    this.heartbeatTimer.unref?.();
  }

  normalizeEvent(evt) {
    if (evt.post_type === 'message' || evt.post_type === 'message_sent') {
      const chatType = evt.message_type === 'group' ? 'group' : 'private';
      const segments = normalizeSegments(evt.message);
      const text = segments.filter((s) => s.type === 'text').map((s) => s.data.text).join('');
      const ats = segments.filter((s) => s.type === 'at').map((s) => String(s.data.qq));
      const replySegment = segments.find((s) => s.type === 'reply');
      const images = segments
        .filter((s) => s.type === 'image' || (s.type === 'mface' && (s.data.url || s.data.file)))
        .map((s) => ({ url: s.data.url || '', file: s.data.file || '', subType: s.type === 'mface' ? 1 : (s.data.sub_type || 0) }));
      const forwards = segments
        .filter((s) => s.type === 'forward' || s.type === 'node')
        .map((s) => ({ id: String(s.data.id || s.data.message_id || ''), title: s.data.title || '' }))
        .filter((item) => item.id);
      const voices = segments
        .filter((s) => s.type === 'record')
        .map((s) => ({ url: s.data.url || '', file: s.data.file || '', seconds: Number(s.data.duration) || 0 }));
      const files = segments
        .filter((s) => s.type === 'file')
        .map((s) => ({ url: s.data.url || '', file: s.data.file || '', name: s.data.name || s.data.file || '', size: Number(s.data.size) || 0 }));
      const sender = evt.sender || {};
      return {
        kind: 'message',
        self: evt.post_type === 'message_sent' || Number(evt.user_id) === Number(this.selfId),
        chatType,
        groupId: Number(evt.group_id) || 0,
        groupName: evt.group_name || '',
        userId: Number(evt.user_id) || Number(sender.user_id) || 0,
        messageId: String(evt.message_id ?? ''),
        time: Number(evt.time) * 1000 || Date.now(),
        sender: {
          userId: Number(sender.user_id) || Number(evt.user_id) || 0,
          nickname: sender.card || sender.nickname || `QQ${evt.user_id}`,
          card: sender.card || '',
          role: sender.role || 'member',
        },
        segments,
        text,
        ats,
        replyId: replySegment ? String(replySegment.data.id) : '',
        images,
        forwards,
        voices,
        files,
        raw: evt,
      };
    }

    if (evt.post_type === 'notice') {
      if (evt.notice_type === 'notify' && evt.sub_type === 'poke') {
        return {
          kind: 'poke',
          chatType: evt.group_id ? 'group' : 'private',
          groupId: Number(evt.group_id) || 0,
          userId: Number(evt.user_id) || 0,
          targetId: Number(evt.target_id) || 0,
          time: Date.now(),
          raw: evt,
        };
      }
      if (evt.notice_type === 'group_upload') {
        const file = evt.file || {};
        return {
          kind: 'file_upload',
          chatType: 'group',
          groupId: Number(evt.group_id) || 0,
          userId: Number(evt.user_id) || 0,
          file: { name: file.name || '', size: Number(file.size) || 0, url: file.url || '', id: file.id || '', busid: file.busid || 0 },
          time: Date.now(),
          raw: evt,
        };
      }
      if (evt.notice_type === 'group_recall') {
        return {
          kind: 'recall',
          chatType: 'group',
          groupId: Number(evt.group_id) || 0,
          userId: Number(evt.user_id) || 0,
          operatorId: Number(evt.operator_id) || 0,
          messageId: String(evt.message_id ?? ''),
          time: Date.now(),
          raw: evt,
        };
      }
      return null;
    }

    if (evt.post_type === 'request') return null;
    return null;
  }

  async sendMessage(chat, segments) {
    if (chat.kind === 'group') {
      return this.call('send_group_msg', { group_id: Number(chat.targetId), message: segments });
    }
    return this.call('send_private_msg', { user_id: Number(chat.targetId), message: segments });
  }

  async recall(messageId) {
    return this.call('delete_msg', { message_id: messageId });
  }

  async getGroupMemberInfo(groupId, userId) {
    return this.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId), no_cache: false });
  }

  async getGroupMemberList(groupId) {
    return this.call('get_group_member_list', { group_id: Number(groupId) });
  }

  async getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: Number(groupId) });
  }

  async getGroupList() {
    return this.call('get_group_list');
  }

  async getFriendList() {
    return this.call('get_friend_list');
  }

  async getMessage(messageId) {
    return this.call('get_msg', { message_id: messageId });
  }

  async getForwardMsg(id) {
    try {
      return await this.call('get_forward_msg', { id });
    } catch {
      return this.call('get_forward_msg', { message_id: id });
    }
  }

  async getGroupFileUrl(groupId, fileId, busid = 0) {
    return this.call('get_group_file_url', { group_id: Number(groupId), file_id: fileId, busid: Number(busid) || 0 });
  }

  async getRecord(file, outFormat = 'wav') {
    try {
      return await this.call('get_record', { file, out_format: outFormat });
    } catch {
      return this.call('get_record', { file, format: outFormat });
    }
  }

  async getGroupHistory(groupId, count = 20) {
    return this.call('get_group_msg_history', { group_id: Number(groupId), count });
  }

  async setGroupBan(groupId, userId, duration) {
    return this.call('set_group_ban', { group_id: Number(groupId), user_id: Number(userId), duration: Number(duration) });
  }

  async setGroupKick(groupId, userId, rejectAddRequest = false) {
    return this.call('set_group_kick', { group_id: Number(groupId), user_id: Number(userId), reject_add_request: rejectAddRequest });
  }

  async sendPoke(userId, groupId = 0) {
    if (groupId) {
      try {
        return await this.call('send_poke', { group_id: Number(groupId), user_id: Number(userId) });
      } catch {
        return this.call('group_poke', { group_id: Number(groupId), user_id: Number(userId) });
      }
    }
    try {
      return await this.call('send_poke', { user_id: Number(userId) });
    } catch {
      return this.call('friend_poke', { user_id: Number(userId) });
    }
  }

  async setQQAvatar(file) {
    return this.call('set_qq_avatar', { file });
  }

  async setQQProfile(profile) {
    return this.call('set_qq_profile', profile);
  }

  async setNickname(nickname) {
    return this.setQQProfile({ nickname });
  }

  close() {
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.connected = false;
  }
}

export function normalizeSegments(message) {
  if (Array.isArray(message)) {
    return message.map((segment) => ({ type: segment.type, data: segment.data || {} }));
  }
  if (typeof message === 'string') {
    return parseCqString(message);
  }
  return [];
}

/** 兼容字符串消息里的 CQ 码（部分实现会这样发送）。 */
export function parseCqString(input) {
  const out = [];
  const regex = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let match;
  const pushText = (text) => {
    if (text) out.push({ type: 'text', data: { text } });
  };
  while ((match = regex.exec(input))) {
    pushText(input.slice(last, match.index));
    const data = {};
    const body = match[2] || '';
    for (const pair of body.split(',').slice(1)) {
      const idx = pair.indexOf('=');
      if (idx > 0) data[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    out.push({ type: match[1] === 'at' ? 'at' : match[1], data });
    last = regex.lastIndex;
  }
  pushText(input.slice(last));
  return out;
}

export function segmentsToText(segments) {
  return segments
    .map((segment) => {
      if (segment.type === 'text') return segment.data.text || '';
      if (segment.type === 'at') return segment.data.qq === 'all' ? '@全体成员' : `@${segment.data.qq}`;
      if (segment.type === 'image') return '[图片]';
      if (segment.type === 'record') return '[语音]';
      if (segment.type === 'video') return '[视频]';
      if (segment.type === 'face') return '[表情]';
      if (segment.type === 'mface') return '[表情包]';
      if (segment.type === 'reply') return '';
      if (segment.type === 'poke') return '[拍一拍]';
      return '';
    })
    .join('');
}

export const message = {
  text: (text) => ({ type: 'text', data: { text: String(text) } }),
  at: (qq) => ({ type: 'at', data: { qq: String(qq) } }),
  reply: (id) => ({ type: 'reply', data: { id: String(id) } }),
  image: (file) => ({ type: 'image', data: { file: String(file) } }),
  record: (file) => ({ type: 'record', data: { file: String(file) } }),
  video: (file) => ({ type: 'video', data: { file: String(file) } }),
  file: (file, name = '') => ({ type: 'file', data: { file: String(file), name: String(name) } }),
  face: (id) => ({ type: 'face', data: { id: String(id) } }),
};

export { sleep };

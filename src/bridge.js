import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { OneBot, message as msg, segmentsToText, normalizeSegments } from './onebot.js';
import { DshRuntime } from './dsh-sdk.js';
import { AdminService, analyzeHostility, shouldSelfRecall } from './admin.js';
import { MemoryStore } from './memory.js';
import { SlangStore } from './slang.js';
import { UsageLedger, readBalance, formatBalance } from './balance.js';
import { buildTurnPrompt, buildOwnerPrompt, buildOwnerGroupPrompt, buildWakeConfig, describeWake } from './prompt.js';
import { findAvatars, setAvatar } from './avatar.js';
import { StickerStore } from './stickers.js';
import { huntStickers } from './sticker-hunt.js';
import { autoChangeAvatar, avatarState } from './avatar-auto.js';
import { ControlServer } from './control.js';
import { searchWeb, fetchWeb, readWebPage, httpGet } from './web.js';
import { RelationsStore } from './relations.js';
import { ArchiveStore } from './archive.js';
import { DiaryStore } from './diary.js';
import { transcribeMessage } from './voice.js';
import { resolveSong } from './music.js';
import { resolveVideo } from './video.js';
import { parseOwnerCommand, isOwnerUser, ownerCommandPrefix } from './owner-command.js';
import { learnSlang, lastLearn } from './slang-learn.js';
import { clamp, ensureDir, formatDateTime, randomToken, readJson, sleep, splitOutgoing, truncate, writeJsonAtomic } from './util.js';

const DIRECT_NAME_HINTS = ['小鲸鱼', '鲸鱼', 'deepseek', 'd指导', 'd老师', 'd师傅'];

export class Bridge extends EventEmitter {
  constructor(config, log) {
    super();
    this.config = config;
    this.log = log;
    this.startedAt = Date.now();
    this.chats = new Map();
    this.onebot = new OneBot(config.snowluma, log.child('onebot'));
    this.admin = new AdminService({ config, onebot: this.onebot, log: log.child('admin') });
    this.memory = new MemoryStore(config, log.child('memory'));
    this.slang = new SlangStore(config, log.child('slang'));
    this.usage = new UsageLedger(config, log.child('usage'));
    this.relations = new RelationsStore(config, log.child('relations'));
    this.archive = new ArchiveStore(config, log.child('archive'));
    this.diary = new DiaryStore(config, log.child('diary'));
    this.audit = [];
    this.thinkings = [];
    this.proactiveTimer = null;
    this.maintenanceTimer = null;
    this.learning = false;
    this.dsh = null;
    this.dshReady = false;
    this.dshStarting = false;
    this.ownerDsh = null;
    this.ownerDshReady = false;
    this.ownerDshStarting = false;
    this.saveTimer = null;
    this.deniedLogged = new Set();
    this.stickerStore = new StickerStore(config, log.child('stickers'));
    this.stickers = this.stickerStore.data;
    this.recognizeQueue = [];
    this.recognizing = false;
    this.recognizeTimes = [];
    this.avatarChanging = false;
    this.stickerVisionCount = 0;
    this.visionSessionBase = `session-qq-sticker-vision-${crypto.randomBytes(4).toString('hex')}`;
    this.generalVisionBase = `session-qq-vision-${crypto.randomBytes(4).toString('hex')}`;
    this._loadState();
  }

  _loadState() {
    const state = readJson(path.join(this.config.paths.state, 'state.json'), null);
    if (!state?.chats) return;
    for (const [key, saved] of Object.entries(state.chats)) {
      if (!saved || !saved.kind) continue;
      const chat = this._newChat(saved.kind, Number(saved.targetId), saved.name || '');
      chat.token = saved.token || chat.token;
      chat.sessionId = saved.sessionId || chat.sessionId;
      chat.readSeq = Number(saved.readSeq) || 0;
      chat.lastSeq = Number(saved.lastSeq) || 0;
      chat.seenSeq = chat.readSeq;
      chat.wake = buildWakeConfig(saved.wake || {}, {});
      if (saved.autoState === false) chat.social.autoState = false;
      this.chats.set(key, chat);
    }
    this.log.info(`已恢复 ${this.chats.size} 个 QQ 会话`);
  }

  saveState() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const chats = {};
      for (const [key, chat] of this.chats) {
        chats[key] = {
          kind: chat.kind,
          targetId: chat.targetId,
          name: chat.name,
          token: chat.token,
          sessionId: chat.sessionId,
          readSeq: chat.readSeq,
          lastSeq: chat.lastSeq,
          wake: chat.wake,
          autoState: chat.social?.autoState !== false,
        };
      }
      try {
        writeJsonAtomic(path.join(this.config.paths.state, 'state.json'), { version: 1, savedAt: Date.now(), chats });
      } catch (error) {
        this.log.warn(`保存状态失败：${error.message}`);
      }
    }, 2000);
    this.saveTimer.unref?.();
  }

  _newChat(kind, targetId, name = '') {
    const key = `${kind}:${targetId}`;
    const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
    return {
      key,
      kind,
      targetId,
      name,
      token: randomToken(8),
      sessionId: `session-qq-${kind}-${hash}`,
      ownerSessionId: `session-qq-owner-${hash}`,
      ownerSessionReady: false,
      readSeq: 0,
      lastSeq: 0,
      seenSeq: 0,
      messages: [],
      wake: buildWakeConfig(
        {
          mode: this.config.wake.defaultMode,
          probability: this.config.wake.defaultProbability,
          keywords: this.config.wake.keywords,
        },
        {},
      ),
      selfRole: null,
      running: false,
      timer: null,
      pendingWake: null,
      wakeTimes: [],
      lastWakeAt: 0,
      lastSentAt: 0,
      sentDuringTurn: false,
      seenThisTurn: 0,
      waiters: new Set(),
      note: '',
      lastHostileAt: 0,
      lastProactiveAt: 0,
      pendingProactive: false,
      lastGrudgeAt: 0,
      social: {
        state: 'diving',
        window: [],
        lastJoinAt: 0,
        coolingUntil: 0,
        autoState: true,
        timer: null,
        log: [],
      },
      thinkings: [],
      createdAt: Date.now(),
    };
  }

  getChat(evt) {
    const kind = evt.chatType === 'group' ? 'group' : 'private';
    const targetId = kind === 'group' ? evt.groupId : evt.userId;
    const key = `${kind}:${targetId}`;
    let chat = this.chats.get(key);
    if (!chat) {
      chat = this._newChat(kind, targetId, evt.groupName || evt.sender?.nickname || '');
      this.chats.set(key, chat);
      this.log.info(`新会话 ${key} -> ${chat.sessionId}`);
      this.saveState();
    } else if (evt.groupName && !chat.name) {
      chat.name = evt.groupName;
    }
    return chat;
  }

  chatByToken(token) {
    if (!token) throw new Error('缺少会话令牌 token');
    for (const chat of this.chats.values()) {
      if (chat.token === token) return chat;
    }
    throw new Error('会话令牌无效或已过期');
  }

  async start() {
    this.log.info('正在启动 QQ 桥接…');
    this.onebot.on('event', (evt) => this.handleEvent(evt).catch((error) => this.log.error(error)));
    this.onebot.on('self', (info) => {
      this.selfInfo = info;
      this.broadcastStatus();
    });
    this.onebot.on('open', () => this.broadcastStatus());
    this.onebot.on('close', () => this.broadcastStatus());

    await this.onebot.start();
    this.log.info(this.onebot.connected ? 'SnowLuma 已就绪' : 'SnowLuma 暂未连接（稍后自动重连）');

    this.control = await this.createControlServer();
    this.startDsh().catch((error) => this.log.error(`DSH SDK 启动失败：${error.message}`));
    this.startSchedulers();
  }

  async createControlServer() {
    const server = new ControlServer({ bridge: this, config: this.config, log: this.log.child('control') });
    await server.start();
    this.controlUrl = server.url;
    writeJsonAtomic(path.join(this.config.paths.state, 'runtime.json'), {
      url: server.url,
      token: this.config.bridge.token,
      pid: process.pid,
      startedAt: this.startedAt,
    });
    return server;
  }

  async startDsh() {
    if (this.dshStarting) return;
    if (!fs.existsSync(this.config.paths.patch)) {
      this.log.error(`拒绝启动 DSH：patch 不存在 ${this.config.paths.patch}`);
      this.log.error('请先运行 node scripts/setup.mjs。没有 patch 时 SDK 会暴露 bash/文件等本地工具，绝不能在 QQ 场景下启动。');
      return;
    }
    this.dshStarting = true;
    try {
      this.dsh = new DshRuntime({
        command: this.config.dsh.command,
        profile: this.config.dsh.profile,
        patch: this.config.paths.patch,
        workspace: this.config.paths.workspace,
        provider: this.config.dsh.provider,
        model: this.config.dsh.model,
        reasoningEffort: this.config.dsh.reasoningEffort,
        maxTokens: this.config.dsh.maxTokens,
        startupTimeoutMs: this.config.dsh.startupTimeoutMs,
        turnTimeoutMs: this.config.dsh.turnTimeoutMs,
        log: this.log.child('dsh'),
      });
      this.dsh.on('turn', (info) => this.emit('turn', info));
      this.dsh.on('session-event', ({ sessionId, event }) => {
        if (event?.type === 'session/title') {
          const chat = [...this.chats.values()].find((item) => item.sessionId === sessionId);
          if (chat && event.data?.title) chat.title = event.data.title;
        }
      });
      this.dsh.on('exit', (info) => {
        this.dshReady = false;
        this.log.warn(`DSH SDK 退出（code=${info.code}）`);
        this.broadcastStatus();
      });
      await this.dsh.start();
      this.dshReady = true;
      this.log.info('DSH SDK 已就绪');
      this.broadcastStatus();
    } catch (error) {
      this.dshReady = false;
      this.log.error(`DSH SDK 启动失败：${error.message}`);
      setTimeout(() => this.startDsh().catch(() => {}), 10000).unref?.();
    } finally {
      this.dshStarting = false;
    }
  }

  getSelf() {
    return { userId: this.onebot.selfId, nickname: this.onebot.nickname };
  }

  isAllowed(chat, evt) {
    const id = String(chat.targetId);
    const isOwner = this.config.qq.ownerQQ && Number(this.config.qq.ownerQQ) === Number(chat.targetId);
    if (chat.kind === 'private') {
      if (isOwner) return true;
      if ((this.config.qq.deny.private || []).map(String).includes(id)) return false;
      const allow = (this.config.qq.allow.private || []).map(String);
      if (allow.length) return allow.includes(id);
      return !!this.config.qq.allowAllWhenEmpty;
    }
    if ((this.config.qq.deny.groups || []).map(String).includes(id)) return false;
    const allow = (this.config.qq.allow.groups || []).map(String);
    if (allow.length) return allow.includes(id);
    return !!this.config.qq.allowAllWhenEmpty;
  }

  async handleEvent(evt) {
    if (evt.kind === 'poke') {
      await this.handlePoke(evt);
      return;
    }
    if (evt.kind === 'file_upload') {
      await this.handleFileUpload(evt);
      return;
    }
    if (evt.kind !== 'message') return;
    const chat = this.getChat(evt);
    if (!this.isAllowed(chat, evt)) {
      if (!this.deniedLogged.has(chat.key)) {
        this.deniedLogged.add(chat.key);
        this.log.warn(`会话 ${chat.key} 不在白名单内，已忽略（如需放行请修改 config.json 的 qq.allow）`);
      }
      return;
    }
    if (evt.self) {
      const duplicate = evt.messageId && chat.messages.some((item) => item.self && String(item.messageId) === String(evt.messageId));
      if (!duplicate) this.recordSelfMessage(chat, evt);
      return;
    }
    const entry = this.recordMessage(chat, evt);
    if (!entry) return;
    this.slang.observe(entry);
    this.notifyWaiters(chat, entry);
    if (this.config.qq.ackMessage && !chat.acked) {
      chat.acked = true;
      this.sendText(chat, this.config.qq.ackMessage, { source: 'ack' }).catch((error) => this.log.warn(`ack 发送失败：${error.message}`));
    }
    if (!this.dshReady) {
      this.log.warn('DSH 尚未就绪，消息已缓存');
      return;
    }
    if (chat.running) {
      this.log.debug(`${chat.key} 正在思考，新消息已缓存 (#${entry.seq})`);
      return;
    }
    const decision = await this.shouldWake(chat, entry);
    if (!decision.wake) return;
    this.scheduleTurn(chat, decision.reason, null, { grudge: decision.grudge, autoJoin: decision.autoJoin });
  }

  async handlePoke(evt) {
    const kind = evt.groupId ? 'group' : 'private';
    const targetId = evt.groupId ? evt.groupId : evt.userId;
    const chat = this.chats.get(`${kind}:${targetId}`) || this._newChat(kind, targetId, '');
    if (!this.chats.has(chat.key)) this.chats.set(chat.key, chat);
    if (!this.isAllowed(chat, { ...evt, chatType: kind })) return;
    const selfId = Number(this.onebot.selfId);
    if (evt.targetId !== selfId && evt.userId !== selfId) return;
    const entry = {
      seq: ++chat.lastSeq,
      messageId: `poke-${Date.now()}`,
      time: Date.now(),
      userId: evt.userId,
      sender: { userId: evt.userId, nickname: `QQ${evt.userId}`, role: 'member' },
      text: '[拍一拍] 你',
      images: [],
      replyId: '',
      self: false,
      atSelf: true,
      poke: true,
    };
    chat.messages.push(entry);
    if (chat.messages.length > this.config.chat.historySize) chat.messages.shift();
    this.notifyWaiters(chat, entry);
    if (chat.running) return;
    if (chat.wake.triggers.poke !== false) this.scheduleTurn(chat, '有人拍了拍你');
  }

  recordMessage(chat, evt) {
    if (evt.messageId && chat.messages.some((item) => String(item.messageId) === String(evt.messageId))) {
      this.log.debug(`忽略重复消息 ${evt.messageId}`);
      return null;
    }
    const selfId = Number(this.onebot.selfId);
    const atSelf = (evt.ats || []).some((qq) => Number(qq) === selfId || qq === 'all');
    const quoted = evt.replyId ? chat.messages.find((item) => String(item.messageId) === String(evt.replyId)) : null;
    // 主人专属指令：群里只有 owner 本人、且 # 在发言最前面，才会被当成 agent 指令。
    const { ownerCommand, commandText } = parseOwnerCommand({ chat, evt, config: this.config });
    const entry = {
      seq: ++chat.lastSeq,
      messageId: evt.messageId,
      time: evt.time,
      userId: evt.userId,
      sender: evt.sender,
      text: evt.text,
      segments: evt.segments,
      images: evt.images || [],
      forwards: evt.forwards || [],
      voices: evt.voices || [],
      files: evt.files || [],
      replyId: evt.replyId,
      replyToSelf: !!quoted?.self,
      ats: evt.ats,
      atSelf,
      self: false,
      ownerCommand,
      commandText,
    };
    chat.messages.push(entry);
    if (chat.messages.length > this.config.chat.historySize) chat.messages.shift();
    this.relations.observe(chat.key, entry, { selfId });
    this.archive.enqueue(chat, entry);
    this.maybeCollectSticker(chat, entry).catch((error) => this.log.debug(`自动收藏表情包失败：${error.message}`));
    this.saveState();
    this.log.info(`[${chat.key}] ${entry.sender.nickname}: ${truncate(entry.text || '[媒体]', 100)}`);
    this.broadcastStatus();
    return entry;
  }

  async handleFileUpload(evt) {
    const chat = this.getChat({ chatType: 'group', groupId: evt.groupId, groupName: '' });
    if (!this.isAllowed(chat, { chatType: 'group', groupId: evt.groupId })) return;
    const file = evt.file || {};
    let url = file.url || '';
    if (!url && file.id) {
      try {
        const info = await this.onebot.getGroupFileUrl(evt.groupId, file.id, file.busid);
        url = info?.url || info?.data?.url || '';
      } catch (error) {
        this.log.warn(`获取群文件下载地址失败：${error.message}`);
      }
    }
    this.archive.recordNotice(chat, {
      messageId: `file-${Date.now()}`,
      userId: evt.userId,
      nickname: `QQ${evt.userId}`,
      name: file.name,
      url,
      size: file.size,
      kind: 'file',
    });
    this.log.info(`[${chat.key}] 群文件：${file.name || '未命名'}（${Math.round((file.size || 0) / 1024)} KB）`);
  }

  recordSelfMessage(chat, evt) {
    const entry = {
      seq: ++chat.lastSeq,
      messageId: evt.messageId,
      time: evt.time,
      userId: Number(this.onebot.selfId),
      sender: { userId: Number(this.onebot.selfId), nickname: this.onebot.nickname, role: chat.selfRole?.role || 'member' },
      text: evt.text,
      segments: evt.segments,
      images: evt.images,
      replyId: evt.replyId,
      self: true,
    };
    chat.messages.push(entry);
    if (chat.messages.length > this.config.chat.historySize) chat.messages.shift();
    chat.lastSentAt = Date.now();
    this.broadcastStatus();
    return entry;
  }

  describeSocial(chat) {
    const social = chat.social;
    if (!social) return '';
    const label = { diving: '潜水', cooling: '冷却', active: '活跃', watching: '观察' }[social.state] || social.state;
    const parts = [label];
    if (social.state === 'cooling' && social.coolingUntil > Date.now()) {
      parts.push(`还剩 ${Math.ceil((social.coolingUntil - Date.now()) / 1000)} 秒`);
    }
    parts.push(`自动结束潜水=${social.autoState !== false && this.config.wake.autoState !== false ? '开' : '关'}`);
    return parts.join('｜');
  }

  setSocial(chat, state, note = '') {
    const social = (chat.social ||= { state: 'diving', window: [], lastJoinAt: 0, coolingUntil: 0, autoState: true, log: [] });
    if (social.state === state) return;
    const previous = social.state;
    social.state = state;
    social.log.push({ at: Date.now(), from: previous, to: state, note });
    if (social.log.length > 40) social.log = social.log.slice(-30);
    this.log.info(`[social] ${chat.key} ${previous} -> ${state}${note ? `（${note}）` : ''}`);
    this.broadcastStatus();
  }

  async shouldWake(chat, entry) {
    const selfId = Number(this.onebot.selfId);
    const wake = chat.wake;
    const now = Date.now();
    const textLower = String(entry.text || '').toLowerCase();
    const social = (chat.social ||= { state: 'diving', window: [], lastJoinAt: 0, coolingUntil: 0, autoState: true, log: [] });

    // 最近的发言窗口：用来判断“群里聊热了”
    social.window.push({ t: now, userId: entry.userId });
    const hotWindowMs = this.config.wake.hotWindowMs || 90000;
    social.window = social.window.filter((item) => now - item.t <= hotWindowMs);
    if (social.state === 'cooling' && now >= (social.coolingUntil || 0)) {
      this.setSocial(chat, 'diving', '冷却结束，重新潜水');
    }
    if (chat.running) return { wake: false, reason: '' };
    // 主人的 # 指令硬唤醒：无视潜水/静默/冷却/频率限制（已经验过发言者是 owner 本人）。
    if (entry.ownerCommand) return { wake: true, reason: '主人指令（#）', ownerCommand: true, priority: true };
    if (this.isOwnerChat(chat)) return { wake: true, reason: '主人私聊（agent 模式）' };

    // 大肥鱼是硬唤醒：无视潜水/睡眠/冷却/频率限制，只做几秒去重
    const grudgeWord = (this.config.wake.grudgeKeywords || []).find((word) => word && textLower.includes(String(word).toLowerCase()));
    if (grudgeWord) {
      const dedupe = this.config.wake.grudgeCooldownMs || 8000;
      if (now - (chat.lastGrudgeAt || 0) < dedupe) return { wake: false, reason: '' };
      chat.lastGrudgeAt = now;
      return { wake: true, reason: `有人叫你「${grudgeWord}」——炸毛`, grudge: true, priority: true };
    }

    const keywords = [...(this.config.wake.keywords || []), ...(wake.keywords || [])];
    const keywordHit = keywords.find((word) => word && textLower.includes(String(word).toLowerCase()));
    const nameMention =
      wake.triggers.nameMention !== false &&
      (DIRECT_NAME_HINTS.some((word) => textLower.includes(word.toLowerCase())) || (this.onebot.nickname && textLower.includes(String(this.onebot.nickname).toLowerCase())));
    const replyToSelf = !!entry.replyId && chat.messages.some((item) => String(item.messageId) === String(entry.replyId) && item.self);
    const atSelf = !!entry.atSelf;
    const speakerHit = (wake.triggers.speakerIds || []).map(String).includes(String(entry.userId));
    const questionHit = !!wake.triggers.question && /[?？]|吗|呢|怎么|为什么|是不是/.test(entry.text || '');
    const direct = atSelf || replyToSelf || nameMention || speakerHit || (keywordHit && wake.triggers.keyword !== false) || (questionHit && wake.triggers.question);

    let reason = '';
    if (atSelf) reason = '有人 @ 了你';
    else if (replyToSelf) reason = '有人引用了你的消息';
    else if (nameMention) reason = `有人提到${this.onebot.nickname || '你'}`;
    else if (keywordHit) reason = `命中关键词「${keywordHit}」`;
    else if (speakerHit) reason = '你在等的人说话了';
    else if (questionHit) reason = '有人在提问';

    if (wake.sleepUntil && now < wake.sleepUntil && !direct) return { wake: false, reason: '' };
    if (wake.mode === 'muted' && !direct) return { wake: false, reason: '' };

    // 频率限制（直接点名/引用仍可突破）
    chat.wakeTimes = chat.wakeTimes.filter((ts) => now - ts < 3600000);
    const perMinute = chat.wakeTimes.filter((ts) => now - ts < 60000).length;
    if (perMinute >= (this.config.wake.maxPerMinute || 1) && !atSelf && !replyToSelf) return { wake: false, reason: '' };
    if (chat.wakeTimes.length >= (this.config.wake.maxPerHour || 12) && !atSelf && !replyToSelf) return { wake: false, reason: '' };
    if (now - chat.lastWakeAt < (this.config.wake.cooldownMs || 0) && !atSelf && !replyToSelf) return { wake: false, reason: '' };

    // 自动结束潜水：群聊变热、且冷却/频率允许时，按概率主动加入
    const autoState = social.autoState !== false && this.config.wake.autoState !== false;
    const hot = social.window.length >= (this.config.wake.hotMessageCount || 4);
    const coolingOver = now - (social.lastJoinAt || 0) >= (this.config.wake.coolingMs || 120000);
    const canAutoJoin = autoState && hot && coolingOver && (!wake.sleepUntil || now >= wake.sleepUntil) && social.state !== 'active';
    const autoJoin = canAutoJoin && Math.random() < (this.config.wake.joinProbability ?? 0.35);

    let wakeNow = false;
    if (wake.mode === 'active') wakeNow = true;
    else if (wake.mode === 'diving') wakeNow = direct || autoJoin;
    else if (wake.mode === 'auto') wakeNow = direct || autoJoin || Math.random() < (wake.probability ?? 0.08);
    else wakeNow = direct;

    if (!wakeNow) return { wake: false, reason: '' };
    if (autoJoin && !direct) reason = `群里聊热了（${social.window.length} 条/${Math.round(hotWindowMs / 1000)} 秒），自动结束潜水`;
    else if (!reason) reason = wake.mode === 'active' ? '活跃模式，看看群里在聊什么' : '普通消息，随机醒来看看';
    return { wake: true, reason, autoJoin, grudge: false };
  }

  scheduleTurn(chat, reason, delayMs = null, opts = {}) {
    chat.pendingWake = reason;
    if (opts.proactive) chat.pendingProactive = true;
    if (opts.grudge) chat.pendingGrudge = true;
    if (opts.autoJoin) chat.pendingAutoJoin = true;
    if (chat.timer) return;
    chat.lastWakeAt = Date.now();
    chat.wakeTimes = chat.wakeTimes.filter((ts) => Date.now() - ts < 3600000);
    chat.wakeTimes.push(Date.now());
    const delay = delayMs ?? this.config.chat.batchWindowMs;
    chat.timer = setTimeout(() => {
      chat.timer = null;
      this.runTurn(chat).catch((error) => this.log.error(`回合失败：${error.stack || error.message}`));
    }, delay);
    chat.timer.unref?.();
  }

  async ensureSelfRole(chat) {
    if (chat.kind !== 'group') return { role: 'member', canManage: false };
    if (chat.selfRole && Date.now() - chat.selfRole.at < 60000) return chat.selfRole;
    const role = await this.admin.selfRole(chat.targetId);
    chat.selfRole = { ...role, at: Date.now() };
    return chat.selfRole;
  }

  isOwnerChat(chat) {
    return chat?.kind === 'private' && this.config.qq.ownerQQ && Number(chat.targetId) === Number(this.config.qq.ownerQQ);
  }

  /** 发言者是不是主人本人（按 OneBot 事件的 userId 判断，客户端伪造不了）。 */
  isOwnerUser(userId) {
    return isOwnerUser(this.config, userId);
  }

  /** 群聊里主人下指令的前缀：默认 #，可在 owner.groupCommandPrefix 改。 */
  ownerCommandPrefix() {
    return ownerCommandPrefix(this.config);
  }

  async ensureOwnerAgent() {
    if (this.ownerDshReady && this.ownerDsh) return;
    if (this.ownerDshStarting) {
      while (this.ownerDshStarting) await new Promise((resolve) => setTimeout(resolve, 200));
      return;
    }
    this.ownerDshStarting = true;
    try {
      const owner = this.config.owner || {};
      const patch = this.config.paths.ownerPatch && fs.existsSync(this.config.paths.ownerPatch) ? this.config.paths.ownerPatch : '';
      if (!patch) this.log.warn('owner patch 不存在，将以无 patch 的 sdk profile 启动（有本地工具，但没有 QQ 工具）');
      this.ownerDsh = new DshRuntime({
        command: this.config.dsh.command,
        profile: owner.profile || this.config.dsh.profile,
        patch,
        workspace: this.config.paths.ownerWorkspace,
        provider: owner.provider || this.config.dsh.provider,
        model: owner.model || this.config.dsh.model,
        reasoningEffort: owner.reasoningEffort || this.config.dsh.reasoningEffort,
        maxTokens: owner.maxTokens || this.config.dsh.maxTokens,
        startupTimeoutMs: this.config.dsh.startupTimeoutMs,
        turnTimeoutMs: this.config.dsh.turnTimeoutMs,
        log: this.log.child('owner-dsh'),
      });
      this.ownerDsh.on('exit', () => {
        this.ownerDshReady = false;
        this.log.warn('owner DSH 已退出');
      });
      await this.ownerDsh.start();
      this.ownerDshReady = true;
      this.log.info('owner agent 已就绪');
      this.broadcastStatus();
    } finally {
      this.ownerDshStarting = false;
    }
  }

  async ensureOwnerSession(chat) {
    if (!this.ownerDshReady || !this.ownerDsh) await this.ensureOwnerAgent();
    if (chat.ownerSessionReady) return;
    const ok = await this.ownerDsh.resume(chat.ownerSessionId);
    chat.ownerSessionReady = true;
    if (ok) this.log.info(`${chat.key} 恢复 owner 会话 ${chat.ownerSessionId}`);
    else this.log.info(`${chat.key} 新建 owner 会话 ${chat.ownerSessionId}`);
  }

  async ensureSession(chat) {
    if (!this.dshReady || !this.dsh) throw new Error('DSH SDK 尚未就绪');
    if (chat.sessionReady) return;
    const ok = await this.dsh.resume(chat.sessionId);
    chat.sessionReady = true;
    if (ok) this.log.info(`${chat.key} 恢复会话 ${chat.sessionId}`);
    else this.log.info(`${chat.key} 新建会话 ${chat.sessionId}`);
  }

  async runTurn(chat) {
    if (chat.running) return;
    const hasOwnerCommand = chat.messages.some((item) => item.seq > chat.readSeq && !item.self && item.ownerCommand);
    const ownerAgent = (this.isOwnerChat(chat) || hasOwnerCommand) && this.config.owner?.agentMode !== false;
    if (!this.dshReady && !ownerAgent) return;
    const proactive = !!chat.pendingProactive;
    const grudge = !!chat.pendingGrudge;
    const autoJoin = !!chat.pendingAutoJoin;
    chat.pendingProactive = false;
    chat.pendingGrudge = false;
    chat.pendingAutoJoin = false;
    const unread = chat.messages.filter((item) => item.seq > chat.readSeq && !item.self).slice(-this.config.chat.maxBatchMessages);
    if (!unread.length && !proactive) return;
    const reason = chat.pendingWake || '新消息';
    chat.pendingWake = null;
    chat.running = true;
    chat.sentDuringTurn = false;
    chat.sentStickerDuringTurn = false;
    chat.sentThisTurn = 0;
    const turnStartSeq = chat.lastSeq;
    chat.currentWake = reason;
    chat.currentGrudge = grudge;
    chat.trace = [];
    this.pushTrace(chat, 'wake', reason, { grudge, autoJoin });
    if (unread.length) this.pushTrace(chat, 'see', `看到 ${unread.length} 条消息`);
    if (chat.social?.timer) clearTimeout(chat.social.timer);
    if (chat.social) chat.social.lastJoinAt = Date.now();
    this.setSocial(chat, 'active', grudge ? '被大肥鱼炸醒' : proactive ? '主动开话题' : autoJoin ? '自动结束潜水' : '参与对话');
    this.broadcastStatus();
    try {
      if (ownerAgent) await this.ensureOwnerSession(chat);
      else await this.ensureSession(chat);
      await this.ensureSelfRole(chat);
      if (unread.length) {
        await this.enrichMessages(chat, unread);
        chat.seenSeq = Math.max(chat.seenSeq, unread[unread.length - 1].seq);
      }
      const balance = readBalance(this.config, this.log);
      const memoryText = this.memory.render(chat.key);
      const relationsText = this.relations.render(chat.key);
      const diary = this.diary.recent(chat.key, 1);
      const slangHints = this.slang.hints(this.config.slang.maxInject || 8);
      let adminHint = '';
      if (chat.kind === 'group' && this.config.admin.enabled) {
        const hostile = this.findHostile(unread);
        if (hostile && Date.now() - chat.lastHostileAt > (this.config.admin.hostileCooldownMs || 300000)) {
          chat.lastHostileAt = Date.now();
          adminHint = this.describeHostileHint(chat, hostile);
          this.pushTrace(chat, 'hint', '有人踩雷，已提示可用群管理');
        }
      }
      const selfRecallNote = chat.note || '';
      chat.note = '';
      const ownerCommandMessage = unread.find((item) => item.ownerCommand);
      const prompt = ownerAgent
        ? chat.kind === 'group'
          ? buildOwnerGroupPrompt({
              chat: { ...chat, ownerQQ: this.config.qq.ownerQQ },
              messages: unread,
              command: ownerCommandMessage?.commandText || '',
              self: this.getSelf(),
            })
          : buildOwnerPrompt({ chat, messages: unread, self: this.getSelf() })
        : buildTurnPrompt({
            chat,
            messages: unread,
            history: chat.messages,
            self: this.getSelf(),
            balance,
            wake: { reasonText: reason, config: chat.wake },
            socialText: this.describeSocial(chat),
            memoryText,
            slangHints,
            adminHint,
            selfRecallNote,
            relationsText,
            diaryText: diary?.text || '',
            model: this.config.dsh.model,
          });
      this.log.info(`${chat.key} 唤醒：${reason}（${unread.length} 条${ownerAgent ? (ownerCommandMessage ? '，owner 指令' : '，owner agent') : ''}）`);
      const runtime = ownerAgent ? this.ownerDsh : this.dsh;
      let sessionId = ownerAgent ? chat.ownerSessionId : chat.sessionId;
      let result;
      try {
        result = await runtime.prompt(sessionId, prompt);
      } catch (error) {
        // 旧会话文件被上一个 DSH 进程占着写句柄时会话就废了：换一个新 id 重来一次。
        if (/already exists|already owned|write handle/i.test(error.message)) {
          const rotated = `${sessionId}-${Date.now().toString(36)}`;
          this.log.warn(`${chat.key} 会话 ${sessionId} 被占用（${error.message}），换新会话 ${rotated} 重试`);
          sessionId = rotated;
          if (ownerAgent) {
            chat.ownerSessionId = rotated;
            chat.ownerSessionReady = true;
          } else {
            chat.sessionId = rotated;
            chat.sessionReady = true;
          }
          result = await runtime.prompt(rotated, prompt);
        } else {
          throw error;
        }
      }
      await this.afterTurn(chat, result, turnStartSeq, { reason, grudge, autoJoin, ownerAgent });
    } catch (error) {
      this.log.error(`${chat.key} 回合失败：${error.message}`);
      if (/未知|unknown|not found|resume|occupied|已存在/i.test(error.message)) {
        chat.sessionReady = false;
      }
      if (chat.social) this.setSocial(chat, 'diving', '回合失败，回到潜水');
    } finally {
      chat.running = false;
      chat.readSeq = Math.max(chat.readSeq, Math.min(chat.seenSeq, chat.lastSeq));
      this.saveState();
      this.broadcastStatus();
      const pendingMessages = chat.messages.filter((item) => item.seq > chat.readSeq && !item.self);
      if (pendingMessages.length && !chat.timer) {
        // 主人的 # 指令优先处理，别被后面插进来的普通消息挤掉
        const ownerPending = pendingMessages.find((item) => item.ownerCommand);
        if (ownerPending) {
          this.scheduleTurn(chat, '主人指令（#）', 0, {});
        } else {
          const last = pendingMessages[pendingMessages.length - 1];
          const decision = await this.shouldWake(chat, last).catch(() => ({ wake: false }));
          if (decision.wake) this.scheduleTurn(chat, decision.reason, 1500, { grudge: decision.grudge, autoJoin: decision.autoJoin });
        }
      }
    }
  }

  findHostile(messages) {
    let best = null;
    for (const message of messages) {
      if (message.self) continue;
      const result = analyzeHostility(message.text || '');
      if (result.hostile && (!best || result.score > best.result.score)) best = { message, result };
    }
    return best;
  }

  describeHostileHint(chat, hostile) {
    const { message, result } = hostile;
    const who = message.sender?.nickname || message.userId;
    if (chat.selfRole?.canManage) {
      return `${who} 刚才的话踩到你的雷点（${result.labels.join('、')}）。你可以嘴硬回怼；如果确实恼火，可以用 mcp__qq__recall_message 撤回这条（messageId=${message.messageId}），或用 mcp__qq__mute_member 禁言对方（userId=${message.userId}）。别滥用特权，只有真的被惹到才动手。`;
    }
    return `${who} 刚才的话踩到你的雷点（${result.labels.join('、')}）。你没有管理员权限，只能嘴硬回怼、装不在乎或者已读乱回，不要假装能禁言/撤回。`;
  }

  async enrichMessages(chat, messages) {
    let forwardCount = 0;
    let voiceCount = 0;
    for (const message of messages) {
      if (message.forwards?.length && !message.forwardText && forwardCount < 2 && this.config.forward?.autoExpand !== false) {
        forwardCount += 1;
        try {
          const data = await this.onebot.getForwardMsg(message.forwards[0].id);
          message.forwardText = this.flattenForward(data, 0);
        } catch (error) {
          message.forwardText = `[转发内容获取失败：${truncate(error.message, 80)}]`;
        }
      }
      if (message.voices?.length && !message.voiceText && voiceCount < 2 && this.config.voice?.autoTranscribe) {
        voiceCount += 1;
        try {
          const result = await transcribeMessage({ onebot: this.onebot, message, config: this.config, log: this.log });
          message.voiceText = result.text || '';
          if (!result.ok) message.voiceText = `[语音] ${result.note || '未转写'}`;
        } catch (error) {
          message.voiceText = `[语音转写失败：${truncate(error.message, 80)}]`;
        }
      }
    }
  }

  flattenForward(data, depth = 0) {
    const nodes = data?.messages || data?.data?.messages || data?.message || data?.data?.message || [];
    if (!Array.isArray(nodes) || !nodes.length) return '[转发内容为空]';
    const maxDepth = this.config.forward?.maxDepth || 2;
    const parts = [];
    for (const node of nodes.slice(0, 30)) {
      const sender = node.sender?.card || node.sender?.nickname || node.nickname || '群友';
      const raw = node.content ?? node.message ?? '';
      const segments = Array.isArray(raw) ? normalizeSegments(raw) : [];
      const text = segments.length ? segmentsToText(segments) : String(raw || '');
      parts.push(`${sender}：${truncate(text || '[媒体]', 200)}`);
      if (depth < maxDepth) {
        const nested = segments
          .filter((segment) => segment.type === 'forward' || segment.type === 'node')
          .map((segment) => segment.data?.id || segment.data?.message_id)
          .filter(Boolean);
        for (const id of nested.slice(0, 2)) parts.push(`  ↳ [嵌套转发 id=${id}]`);
      }
    }
    return truncate(parts.join('\n'), this.config.forward?.maxChars || 900);
  }

  startSchedulers() {
    if (this.proactiveTimer) return;
    const interval = this.config.proactive?.checkIntervalMs || 60000;
    this.proactiveTimer = setInterval(() => {
      this.checkProactive().catch((error) => this.log.warn(`主动话题检查失败：${error.message}`));
    }, interval);
    this.proactiveTimer.unref?.();
    this.maintenanceTimer = setInterval(() => {
      this.runMaintenance().catch((error) => this.log.warn(`维护任务失败：${error.message}`));
    }, 300000);
    this.maintenanceTimer.unref?.();
    const boot = setTimeout(() => this.runMaintenance().catch(() => {}), 15000);
    boot.unref?.();
  }

  stopSchedulers() {
    if (this.proactiveTimer) clearInterval(this.proactiveTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.proactiveTimer = null;
    this.maintenanceTimer = null;
  }

  async checkProactive() {
    if (!this.config.proactive?.enabled) return;
    const now = Date.now();
    for (const chat of this.chats.values()) {
      if (chat.kind !== 'group' || chat.running || chat.timer) continue;
      if (!['auto', 'active'].includes(chat.wake?.mode)) continue;
      if (chat.wake.sleepUntil && now < chat.wake.sleepUntil) continue;
      if (chat.messages.some((item) => item.seq > chat.readSeq && !item.self)) continue;
      const last = chat.messages[chat.messages.length - 1]?.time || chat.createdAt;
      if (now - last < (this.config.proactive.idleThresholdMs ?? 2700000)) continue;
      if (now - (chat.lastProactiveAt || 0) < (this.config.proactive.minGapMs ?? 7200000)) continue;
      if (Math.random() > (this.config.proactive.probability ?? 0.2)) continue;
      chat.lastProactiveAt = now;
      this.log.info(`${chat.key} 冷场主动开话题`);
      this.scheduleTurn(chat, '群里冷场，主动开个话题', 0, { proactive: true });
    }
  }

  async runMaintenance() {
    const now = new Date();
    if (this.config.diary?.enabled) {
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const dueTime = now.getHours() > (this.config.diary.hour ?? 23)
        || (now.getHours() === (this.config.diary.hour ?? 23) && now.getMinutes() >= (this.config.diary.minute ?? 30));
      if (dueTime && this.diary.index.lastRun !== date) await this.runDiary(date);
    }
    await this.runStickerHuntIfDue().catch((error) => this.log.warn(`表情包冲浪失败：${error.message}`));
    this.enqueueUnrecognized(2);
    await this.runAvatarChangeIfDue().catch((error) => this.log.warn(`自动换头像失败：${error.message}`));
    if (this.config.slang?.autoLearn?.enabled && !this.learning) {
      const last = lastLearn(this.config);
      const interval = (this.config.slang.autoLearn.intervalHours || 12) * 3600000;
      if (Date.now() - (last.lastRun || 0) >= interval) {
        this.learning = true;
        try {
          await learnSlang({
            config: this.config,
            log: this.log.child('slang-learn'),
            slang: this.slang,
            limit: this.config.slang.autoLearn.limit || 4,
          });
        } catch (error) {
          this.log.warn(`自动黑话学习失败：${error.message}`);
        } finally {
          this.learning = false;
        }
      }
    }
  }

  enqueueUnrecognized(limit = 2) {
    if (!this.config.sticker?.autoRecognize || this.recognizing || !this.dshReady) return;
    const ids = this.stickerStore.list(100)
      .filter((item) => !item.recognized && item.file && fs.existsSync(item.file))
      .slice(0, limit)
      .map((item) => item.id);
    for (const id of ids) this.enqueueRecognize(id);
  }

  async runStickerHuntIfDue(force = false) {
    const cfg = this.config.sticker?.hunt;
    if (!this.config.sticker?.enabled || cfg?.enabled === false || this.stickerHunting) return;
    const file = path.join(this.config.paths.state, 'sticker-hunt.json');
    const interval = (cfg.intervalHours || 12) * 3600000;
    let state = readJson(file, null);
    if (!state) {
      state = { lastRun: Date.now() - interval + 600000 };
      writeJsonAtomic(file, state);
    }
    if (!force && Date.now() - (state.lastRun || 0) < interval) return;
    this.stickerHunting = true;
    try {
      const result = await huntStickers({ config: this.config, store: this.stickerStore, log: this.log.child('sticker-hunt') });
      for (const id of result.items || []) this.enqueueRecognize(id);
      writeJsonAtomic(file, { lastRun: Date.now(), added: result.added });
      this.log.info(`表情包冲浪：新增 ${result.added} 张`);
      this.broadcastStatus();
    } finally {
      this.stickerHunting = false;
    }
  }

  async runAvatarChangeIfDue(force = false) {
    const ac = this.config.avatar?.autoChange;
    if (!this.config.avatar?.enabled || ac?.enabled === false || this.avatarChanging) return;
    const { state } = avatarState(this.config);
    const interval = (ac.intervalHours || 24) * 3600000;
    const initial = ac.initialDelayMs || 1800000;
    if (!state.lastRun) {
      const { file } = avatarState(this.config);
      state.lastRun = Date.now() - interval + initial;
      writeJsonAtomic(file, state);
    }
    if (!force && Date.now() - state.lastRun < interval) return;
    this.avatarChanging = true;
    try {
      const result = await autoChangeAvatar({
        config: this.config,
        log: this.log.child('avatar-auto'),
        onebot: this.onebot,
        vision: (images, prompt) => this.askVision(images, prompt),
      });
      this.log.info(`自动换头像：${result.reason}（设置=${result.set.ok}）`);
      if (ac.notifyOwner && this.config.qq.ownerQQ) {
        const text = `换头像了：${result.reason}${result.set.ok ? '（已设置）' : '（这版 SnowLuma 不支持自动设置，图已保存）'}`;
        this.onebot.sendMessage({ kind: 'private', targetId: this.config.qq.ownerQQ }, [msg.text(text), msg.image(result.picked.path)]).catch((error) => {
          this.log.warn(`头像通知失败：${error.message}`);
        });
      }
      this.broadcastStatus();
    } finally {
      this.avatarChanging = false;
    }
  }

  stickerList(limit = 50) {
    return { items: this.stickerStore.list(limit), stats: this.stickerStore.stats() };
  }

  /** 拉黑 / 恢复某个表情包（拉黑后自动配图和 send_sticker 都不会再用）。 */
  stickerSetDisabled(id, disabled = true) {
    const item = this.stickerStore.setDisabled(id, disabled);
    this.broadcastStatus();
    return { ok: true, item, disabled: !!item.disabled, stats: this.stickerStore.stats() };
  }

  async stickerHuntNow() {
    await this.runStickerHuntIfDue(true);
    return this.stickerList(20);
  }

  async stickerRecognize(id) {
    await this.recognizeSticker(id);
    return this.stickerStore.get(id);
  }

  async avatarChangeNow() {
    await this.runAvatarChangeIfDue(true);
    return avatarState(this.config).state.current;
  }

  async runDiary(date) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    let chats = 0;
    const summaries = [];
    for (const chat of this.chats.values()) {
      const messages = chat.messages.filter((item) => !item.self && item.time >= start.getTime());
      if (!messages.length) continue;
      const doc = this.diary.generate(chat, messages, {
        relationsText: this.relations.render(chat.key),
        memoryText: this.memory.render(chat.key),
      });
      this.diary.save(date, chat, doc);
      chats += 1;
      summaries.push(`${doc.title}：${doc.stats.messages} 条`);
    }
    this.diary.index.lastRun = date;
    writeJsonAtomic(path.join(this.config.paths.state, 'diary.json'), this.diary.index);
    this.log.info(`小鲸鱼日记已生成：${date}（${chats} 个会话）`);
    if (this.config.diary?.sendToOwner && this.config.qq.ownerQQ && summaries.length) {
      const text = `今天的日记写好了（${date}）\n${summaries.join('\n')}\n存在 workspace/diary/${date}.md`;
      this.onebot.sendMessage({ kind: 'private', targetId: this.config.qq.ownerQQ }, [msg.text(text)]).catch((error) => {
        this.log.warn(`日记发给主人失败：${error.message}`);
      });
    }
    return { date, chats, summaries };
  }

  recordAudit(entry) {
    this.audit.push({ ts: Date.now(), ...entry });
    if (this.audit.length > 500) this.audit = this.audit.slice(-400);
  }

  async restartDsh() {
    this.log.info('重启 DSH SDK 以加载最新人格/patch…');
    if (this.dsh) {
      try {
        await this.dsh.shutdown();
      } catch {
        /* ignore */
      }
      this.dsh = null;
    }
    if (this.ownerDsh) {
      try {
        await this.ownerDsh.shutdown();
      } catch {
        /* ignore */
      }
      this.ownerDsh = null;
      this.ownerDshReady = false;
      this.ownerDshStarting = false;
    }
    this.dshReady = false;
    this.dshStarting = false;
    await this.startDsh();
    return this.dshReady;
  }

  resetAllSessions() {
    for (const chat of this.chats.values()) {
      chat.sessionId = `session-qq-${chat.kind}-${crypto.randomBytes(5).toString('hex')}`;
      chat.sessionReady = false;
      chat.running = false;
      if (chat.timer) {
        clearTimeout(chat.timer);
        chat.timer = null;
      }
    }
    this.saveState();
    this.broadcastStatus();
    return this.chats.size;
  }

  async afterTurn(chat, result, turnStartSeq, { reason = '', grudge = false, autoJoin = false, ownerAgent = false } = {}) {
    const text = String(result.text || '').trim();
    const noReply = !text || /^\[(silent|no[_-]?reply|潜水|不说话)\]$/i.test(text);
    if (!chat.sentDuringTurn && !noReply) {
      const latest = [...chat.messages].reverse().find((item) => !item.self && item.seq <= turnStartSeq);
      await this.sendText(chat, text, {
        replyTo: this.config.chat.replyToTrigger && latest && latest.atSelf ? latest.messageId : '',
        source: 'fallback',
      });
    }
    if (result.usage) {
      const event = this.usage.record(chat.key, result.usage, this.config.dsh.model);
      if (event) this.log.debug(`${chat.key} 用量：in=${event.input} hit=${event.cacheRead} out=${event.output} cost=¥${event.cost}`);
    }
    if (result.reason && result.reason !== 'completed' && result.reason !== 'idle') {
      this.log.warn(`${chat.key} 回合结束原因：${result.reason}`);
    }

    if (!ownerAgent) await this.autoAttachSticker(chat, text, { grudge }).catch((error) => this.log.warn(`自动表情包失败：${error.message}`));

    // 决策轨迹 + 模型推理，一起给控制台看
    const spoke = chat.sentDuringTurn ? '通过工具发过言' : noReply ? '没有发言' : '文本兜底发言';
    this.pushTrace(chat, 'result', spoke);

    // 社交状态：本轮结束后自动冷却，再回到潜水
    if (!ownerAgent && this.config.wake.autoState !== false && chat.social?.autoState !== false) {
      if (chat.wake.mode === 'active') {
        this.setSocial(chat, 'active', '活跃模式，保持在线');
      } else if (chat.wake.sleepUntil && Date.now() < chat.wake.sleepUntil) {
        this.setSocial(chat, 'diving', '进入睡眠');
      } else {
        const base = this.config.wake.coolingMs || 120000;
        const cooling = grudge ? Math.min(90000, base) : base;
        chat.social.coolingUntil = Date.now() + cooling;
        this.setSocial(chat, 'cooling', `本轮结束，冷却 ${Math.round(cooling / 1000)} 秒${grudge ? '（炸毛后冷静）' : ''}`);
        if (chat.social.timer) clearTimeout(chat.social.timer);
        chat.social.timer = setTimeout(() => {
          if (chat.social.state === 'cooling' && !chat.running) this.setSocial(chat, 'diving', '冷却结束，重新潜水');
        }, cooling + 500);
        chat.social.timer.unref?.();
      }
    }
    this.pushTrace(chat, 'social', `社交状态 -> ${chat.social?.state || 'diving'}`);

    const showReasoning = this.config.console?.showReasoning !== false;
    const reasoning = showReasoning ? truncate(String(result.reasoning || ''), this.config.console?.reasoningMaxChars || 4000) : '';
    const traceText = (chat.trace || []).map((item) => `[${item.kind}] ${item.text}`).join('\n');
    const thinking = {
      at: Date.now(),
      chat: chat.key,
      name: chat.name || '',
      trigger: reason || '新消息',
      grudge: !!grudge,
      autoJoin: !!autoJoin,
      durationMs: result.durationMs || 0,
      reasoning,
      trace: traceText,
      text: reasoning || traceText,
    };
    chat.thinkings.push(thinking);
    if (chat.thinkings.length > 20) chat.thinkings = chat.thinkings.slice(-15);
    chat.lastThinking = thinking;
    this.thinkings.push(thinking);
    if (this.thinkings.length > 60) this.thinkings = this.thinkings.slice(-50);
  }

  pushTrace(chat, kind, text, extra = {}) {
    (chat.trace ||= []).push({ at: Date.now(), kind, text: truncate(String(text || ''), 400), ...extra });
    if (chat.trace.length > 40) chat.trace = chat.trace.slice(-30);
    chat.liveTrace = chat.trace.map((item) => `[${item.kind}] ${item.text}`).join('\n');
  }

  noteToolCall(tool, params) {
    let chat;
    try {
      chat = this.chatByToken(params?.token);
    } catch {
      return;
    }
    if (!chat?.running) return;
    this.pushTrace(chat, 'tool', `${tool} ${summarizeToolArgs(tool, params)}`);
    this.broadcastStatus();
  }

  async sendText(chat, text, { replyTo = '', atUserId = '', source = 'agent' } = {}) {
    const parts = splitOutgoing(text, this.config.chat.maxReplyChars, this.config.chat.burstMaxMessages);
    if (!parts.length) return { count: 0, messageIds: [] };
    const messageIds = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const segments = [];
      if (i === 0 && replyTo) segments.push(msg.reply(replyTo));
      if (i === 0 && atUserId) segments.push(msg.at(atUserId));
      segments.push(msg.text(part));
      try {
        const data = await this.onebot.sendMessage(chat, segments);
        const messageId = String(data?.message_id ?? data?.messageId ?? '');
        messageIds.push(messageId);
        chat.sentThisTurn = (chat.sentThisTurn || 0) + 1;
        chat.sentDuringTurn = true;
        chat.lastSentAt = Date.now();
        this.recordSelfMessage(chat, {
          messageId,
          time: Date.now(),
          text: part,
          segments,
          images: [],
          replyId: replyTo,
        });
        if (i === 0 && replyTo) {
          const target = chat.messages.find((item) => String(item.messageId) === String(replyTo));
          if (target?.userId) this.relations.bump(chat.key, target.userId, 0.3);
        }
        this.log.info(`[${chat.key}] 发送：${truncate(part, 80)}`);
        if (this.config.admin.autoSelfRecall?.enabled) {
          const check = shouldSelfRecall(part, this.config);
          if (check.recall) this.scheduleSelfRecall(chat, messageId, part, check.reason);
        }
        if (i < parts.length - 1) {
          const gap = this.config.chat.sendGapMs + part.length * this.config.chat.sendGapPerCharMs;
          await sleep(Math.min(4000, Math.max(400, gap)));
        }
      } catch (error) {
        this.log.error(`发送失败：${error.message}`);
        break;
      }
    }
    this.broadcastStatus();
    return { count: messageIds.length, messageIds, source };
  }

  scheduleSelfRecall(chat, messageId, text, reason) {
    if (!messageId) return;
    setTimeout(async () => {
      try {
        await this.admin.recall(chat, messageId, { bySelf: true });
        chat.note = `你刚才那条「${truncate(text, 40)}」太${reason === 'too-long' ? '长' : '像 AI'}了，已经被你自己撤回。下一条注意短一点、更像群友。`;
        this.log.info(`[${chat.key}] 已自动撤回自己的消息 ${messageId}（${reason}）`);
        this.broadcastStatus();
      } catch (error) {
        this.log.warn(`自动撤回失败：${error.message}`);
      }
    }, 1800).unref?.();
  }

  notifyWaiters(chat, entry) {
    for (const waiter of [...chat.waiters]) {
      if (entry.seq <= waiter.after) continue;
      waiter.lastAt = Date.now();
      waiter.count += 1;
      if (!waiter.quietMs) {
        this.resolveWaiter(chat, waiter, false);
      } else {
        clearTimeout(waiter.timer);
        waiter.timer = setTimeout(() => this.resolveWaiter(chat, waiter, false), waiter.quietMs);
      }
    }
  }

  resolveWaiter(chat, waiter, timedOut) {
    if (waiter.done) return;
    waiter.done = true;
    clearTimeout(waiter.timer);
    chat.waiters.delete(waiter);
    const messages = chat.messages.filter((item) => item.seq > waiter.after).slice(-30);
    const through = messages.length ? messages[messages.length - 1].seq : waiter.after;
    chat.seenSeq = Math.max(chat.seenSeq, through);
    waiter.resolve({
      messages: messages.map(publicMessage),
      readThroughSeq: through,
      timedOut,
      quiet: !timedOut,
      count: messages.length,
    });
  }

  // ───────────────────────── 工具方法（控制面调用） ─────────────────────────

  async toolSendMessage({ token, messages, replyToMessageId, atUserId }) {
    const chat = this.chatByToken(token);
    const list = Array.isArray(messages) ? messages : [messages];
    const cleaned = list.map((item) => String(item ?? '').trim()).filter(Boolean);
    if (!cleaned.length) throw new Error('messages 不能为空');
    const joined = cleaned.length > 1 ? cleaned : cleaned[0];
    if (cleaned.length > 1) {
      // 多条按数组逐条发送，保留用户要求的节奏。
      const ids = [];
      for (let i = 0; i < cleaned.length; i += 1) {
        const result = await this.sendText(chat, cleaned[i], {
          replyTo: i === 0 ? replyToMessageId || '' : '',
          atUserId: i === 0 ? atUserId || '' : '',
        });
        ids.push(...result.messageIds);
        if (i < cleaned.length - 1) await sleep(this.config.chat.sendGapMs + cleaned[i].length * this.config.chat.sendGapPerCharMs);
      }
      return { ok: true, count: ids.length, messageIds: ids };
    }
    const result = await this.sendText(chat, joined, { replyTo: replyToMessageId || '', atUserId: atUserId || '' });
    return { ok: true, ...result };
  }

  async toolReply({ token, messageId, messages, atUserId }) {
    return this.toolSendMessage({ token, messages, replyToMessageId: messageId, atUserId });
  }

  async toolWaitMessages({ token, timeoutMs, quietMs, purpose, afterSeq }) {
    const chat = this.chatByToken(token);
    const timeout = clamp(timeoutMs ?? 30000, 1000, this.config.dsh.turnTimeoutMs - 5000);
    const quiet = clamp(quietMs ?? (purpose === 'reply' ? 8000 : 0), 0, 60000);
    const after = Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : chat.seenSeq;
    const existing = chat.messages.filter((item) => item.seq > after);
    if (existing.length && (purpose === 'reply' || !quiet)) {
      const through = existing[existing.length - 1].seq;
      chat.seenSeq = Math.max(chat.seenSeq, through);
      return { messages: existing.map(publicMessage), readThroughSeq: through, timedOut: false, quiet: true, count: existing.length };
    }
    return new Promise((resolve) => {
      const waiter = {
        after,
        quietMs: quiet,
        lastAt: Date.now(),
        count: existing.length,
        done: false,
        timer: null,
        resolve: (value) => {
          clearTimeout(waiter.deadline);
          resolve(value);
        },
      };
      if (quiet) {
        waiter.timer = setTimeout(() => this.resolveWaiter(chat, waiter, false), quiet);
      }
      waiter.deadline = setTimeout(() => this.resolveWaiter(chat, waiter, true), timeout);
      waiter.deadline.unref?.();
      waiter.timer?.unref?.();
      chat.waiters.add(waiter);
    });
  }

  toolMarkRead({ token, throughSeq }) {
    const chat = this.chatByToken(token);
    const through = clamp(throughSeq ?? chat.seenSeq, 0, chat.lastSeq);
    chat.readSeq = Math.max(chat.readSeq, through);
    chat.seenSeq = Math.max(chat.seenSeq, through);
    this.saveState();
    return { ok: true, readSeq: chat.readSeq };
  }

  toolSetWakeConfig({ token, config, throughSeq }) {
    const chat = this.chatByToken(token);
    chat.wake = buildWakeConfig(chat.wake, config || {});
    if (config?.autoState !== undefined && chat.social) chat.social.autoState = !!config.autoState;
    if (config?.mode === 'active') this.setSocial(chat, 'active', '手动切到活跃');
    if (config?.mode === 'diving' || config?.mode === 'muted') this.setSocial(chat, 'diving', '手动切到潜水');
    if (throughSeq !== undefined) {
      chat.readSeq = Math.max(chat.readSeq, clamp(throughSeq, 0, chat.lastSeq));
      chat.seenSeq = Math.max(chat.seenSeq, chat.readSeq);
    }
    this.saveState();
    this.broadcastStatus();
    if (!chat.running && chat.wake.mode === 'active' && chat.messages.some((item) => item.seq > chat.readSeq && !item.self)) {
      this.scheduleTurn(chat, '控制台把唤醒模式切到了活跃');
    }
    return { ok: true, wake: chat.wake, text: describeWake(chat.wake) };
  }

  async toolGetMembers({ token, limit = 100 }) {
    const chat = this.chatByToken(token);
    if (chat.kind !== 'group') return { members: [{ userId: chat.targetId, nickname: chat.name || String(chat.targetId), role: 'member' }] };
    const list = await this.onebot.getGroupMemberList(chat.targetId);
    return {
      members: (list || []).slice(0, clamp(limit, 1, 500)).map((item) => ({
        userId: item.user_id,
        nickname: item.card || item.nickname,
        role: item.role,
      })),
    };
  }

  toolGetActiveMembers({ token, limit = 15 }) {
    const chat = this.chatByToken(token);
    const users = new Map();
    for (const item of chat.messages.slice(-60)) {
      if (!item.userId) continue;
      const rec = users.get(item.userId) || { userId: item.userId, nickname: item.sender?.nickname, count: 0, lastAt: 0 };
      rec.count += 1;
      rec.lastAt = item.time;
      rec.nickname = item.sender?.nickname || rec.nickname;
      users.set(item.userId, rec);
    }
    return { members: [...users.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, limit) };
  }

  toolGetMessageDetail({ token, messageId }) {
    const chat = this.chatByToken(token);
    const item = chat.messages.find((m) => String(m.messageId) === String(messageId));
    if (!item) throw new Error(`没有找到消息 ${messageId}`);
    return { message: publicMessage(item) };
  }

  toolMemoryAppend({ token, kind, text, about }) {
    const chat = this.chatByToken(token);
    const item = this.memory.append(chat.key, { kind, text, about });
    return { ok: !!item, item };
  }

  toolMemoryQuery({ token, term }) {
    const chat = this.chatByToken(token);
    return this.memory.query(chat.key, term);
  }

  toolMemoryRemove({ token, kind, text }) {
    const chat = this.chatByToken(token);
    return { removed: this.memory.remove(chat.key, { kind, text }) };
  }

  toolMemoryClear({ token }) {
    const chat = this.chatByToken(token);
    this.memory.clear(chat.key);
    return { ok: true };
  }

  toolSlangQuery({ term }) {
    return this.slang.query(term);
  }

  toolSlangSubmit({ term, meaning, usage, tags }) {
    return { ok: true, entry: this.slang.submit({ term, meaning, usage, tags }) };
  }

  toolSlangList({ limit = 30 }) {
    return { entries: this.slang.list(limit), candidates: this.slang.hints(10) };
  }

  toolBalance({ token }) {
    let chat = null;
    try {
      if (token) chat = this.chatByToken(token);
    } catch {
      chat = null;
    }
    const balance = readBalance(this.config, this.log);
    return {
      balance,
      text: formatBalance(balance),
      tracked: this.usage.summary().totals,
      trackedToday: Number(this.usage.costToday().toFixed(4)),
      chatUsage: chat ? this.usage.summary().chats[chat.key] || null : null,
    };
  }

  async toolAdminStatus({ token }) {
    const chat = this.chatByToken(token);
    if (chat.kind !== 'group') return { chat: chat.key, canManage: false, role: 'private' };
    const role = await this.ensureSelfRole(chat);
    return { chat: chat.key, groupId: chat.targetId, role: role.role, canManage: role.canManage, selfId: this.onebot.selfId, nickname: this.onebot.nickname };
  }

  async toolRecallMessage({ token, messageId, taunt }) {
    const chat = this.chatByToken(token);
    const item = chat.messages.find((m) => String(m.messageId) === String(messageId));
    const bySelf = !!item?.self || String(item?.userId) === String(this.onebot.selfId);
    await this.admin.recall(chat, messageId, { bySelf });
    if (!bySelf && item?.userId) this.relations.adjust(chat.key, item.userId, { delta: -3, note: '被我撤回了' });
    if (taunt) await this.sendText(chat, taunt, { source: 'taunt' });
    return { ok: true, recalled: String(messageId), bySelf };
  }

  async toolRecallLastSelf({ token, taunt }) {
    const chat = this.chatByToken(token);
    const last = [...chat.messages].reverse().find((m) => m.self && /^\d+$/.test(String(m.messageId)));
    if (!last) throw new Error('没有可撤回的自己的消息');
    await this.admin.recall(chat, last.messageId, { bySelf: true });
    if (taunt) await this.sendText(chat, taunt, { source: 'taunt' });
    return { ok: true, messageId: last.messageId };
  }

  async toolMuteMember({ token, userId, durationSeconds, reason, taunt }) {
    const chat = this.chatByToken(token);
    const result = await this.admin.mute(chat, userId, durationSeconds);
    this.relations.adjust(chat.key, userId, { delta: -5, note: `被我禁言 ${durationSeconds || '默认'} 秒` });
    if (taunt) await this.sendText(chat, taunt, { source: 'taunt' });
    return { ok: true, ...result, reason: reason || '' };
  }

  async toolKickMember({ token, userId, reason }) {
    const chat = this.chatByToken(token);
    const result = await this.admin.kick(chat, userId);
    return { ok: true, ...result, reason: reason || '' };
  }

  async toolSendPoke({ token, userId }) {
    const chat = this.chatByToken(token);
    await this.onebot.sendPoke(userId || chat.targetId, chat.kind === 'group' ? chat.targetId : 0);
    return { ok: true };
  }

  async toolFindAvatar({ query, count = 4 }) {
    return findAvatars(query, this.config, this.log, clamp(count, 1, 8));
  }

  async toolSetAvatar({ path: file }) {
    return setAvatar(file, this.onebot, this.log);
  }

  async toolSendImage({ token, path: file, replyToMessageId }) {
    const chat = this.chatByToken(token);
    if (!fs.existsSync(file)) throw new Error(`图片不存在：${file}`);
    const segments = [];
    if (replyToMessageId) segments.push(msg.reply(replyToMessageId));
    segments.push(msg.image(file));
    const data = await this.onebot.sendMessage(chat, segments);
    chat.sentDuringTurn = true;
    chat.sentThisTurn += 1;
    chat.lastSentAt = Date.now();
    const messageId = String(data?.message_id ?? '');
    this.recordSelfMessage(chat, { messageId, time: Date.now(), text: '[图片]', segments, images: [], replyId: replyToMessageId || '' });
    return { ok: true, messageId };
  }

  async maybeCollectSticker(chat, message) {
    if (!this.config.sticker?.enabled || this.config.sticker.autoCollect === false) return;
    const image = (message.images || []).find((item) => Number(item.subType) === 1);
    if (!image?.url && !image?.file) return;
    const now = Date.now();
    this.stickerCollectTimes = (this.stickerCollectTimes || []).filter((ts) => now - ts < 3600000);
    if (this.stickerCollectTimes.length >= 20) return;
    try {
      const media = await this.downloadImage(image);
      const id = crypto.createHash('sha1').update(media.buffer).digest('hex').slice(0, 12);
      const dir = path.join(this.config.paths.media, 'stickers');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${id}.${media.ext}`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, media.buffer);
      const item = this.stickerStore.add({ file, note: message.text || '', source: 'auto', id });
      this.stickerCollectTimes.push(now);
      if (item) this.enqueueRecognize(item.id);
    } catch (error) {
      this.log.debug(`自动下载表情包失败：${error.message}`);
    }
  }

  enqueueRecognize(id) {
    if (!this.config.sticker?.autoRecognize || this.config.sticker.autoRecognize === false) return;
    if (!this.dshReady) return;
    const now = Date.now();
    this.recognizeTimes = (this.recognizeTimes || []).filter((ts) => now - ts < 3600000);
    if (this.recognizeTimes.length >= (this.config.sticker.maxRecognizePerHour || 6)) return;
    this.recognizeQueue.push(String(id));
    this.kickRecognize();
  }

  async kickRecognize() {
    if (this.recognizing || !this.dshReady) return;
    this.recognizing = true;
    try {
      while (this.recognizeQueue.length && this.dshReady) {
        const id = this.recognizeQueue.shift();
        try {
          await this.recognizeSticker(id);
        } catch (error) {
          this.log.warn(`表情包识别失败 ${id}：${error.message}`);
        }
      }
    } finally {
      this.recognizing = false;
    }
  }

  async recognizeSticker(id) {
    const item = this.stickerStore.get(id);
    if (!item || !fs.existsSync(item.file)) return;
    if (item.recognized && item.desc) return;
    const mime = mimeFromExt(item.file);
    const data = fs.readFileSync(item.file).toString('base64');
    this.stickerVisionCount = (this.stickerVisionCount || 0) + 1;
    const sessionId = `${this.visionSessionBase}-${Math.floor(this.stickerVisionCount / 20)}`;
    const prompt = '你是表情包识别器。看这张图，只输出一行 JSON，不要调用任何工具、不要解释：{"desc":"画面内容+图中文字","emotion":"主要情绪，如开心/无语/生气/嘲讽/可爱","tags":["2~5个中文标签"],"usage":"适合在什么聊天场景发"}';
    const result = await this.dsh.prompt(sessionId, prompt, { timeoutMs: 90000, images: [{ data, mimeType: mime }] });
    const text = String(result.text || '');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`识别结果不是 JSON：${truncate(text, 80)}`);
    const parsed = JSON.parse(match[0]);
    if (!parsed.desc) throw new Error('识别结果缺少 desc');
    this.stickerStore.update(id, {
      desc: parsed.desc,
      emotion: parsed.emotion || '',
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      usage: parsed.usage || '',
      recognized: true,
    });
    this.recognizeTimes.push(Date.now());
    this.log.info(`表情包识别完成 ${id}：${truncate(parsed.desc, 50)}`);
    this.broadcastStatus();
  }

  async askVision(images, prompt) {
    if (!this.dshReady) throw new Error('DSH 尚未就绪');
    this.visionCount = (this.visionCount || 0) + 1;
    const sessionId = `${this.generalVisionBase}-${Math.floor(this.visionCount / 10)}`;
    const result = await this.dsh.prompt(sessionId, prompt, { timeoutMs: 120000, images });
    return String(result.text || '');
  }

  async sendStickerToChat(chat, item, { replyToMessageId = '' } = {}) {
    if (!item?.file || !fs.existsSync(item.file)) throw new Error('表情包文件不存在');
    const segments = [];
    if (replyToMessageId) segments.push(msg.reply(replyToMessageId));
    segments.push(msg.image(item.file));
    const data = await this.onebot.sendMessage(chat, segments);
    chat.sentDuringTurn = true;
    chat.sentStickerDuringTurn = true;
    chat.lastAutoStickerAt = Date.now();
    chat.sentThisTurn = (chat.sentThisTurn || 0) + 1;
    chat.lastSentAt = Date.now();
    chat.recentStickers = [...(chat.recentStickers || []), item.id].slice(-8);
    chat.stickerTimes = [...(chat.stickerTimes || []), Date.now()].slice(-50);
    this.stickerStore.markUsed(item.id);
    const messageId = String(data?.message_id ?? '');
    this.recordSelfMessage(chat, { messageId, time: Date.now(), text: '[表情包]', segments, images: [], replyId: replyToMessageId || '' });
    this.log.info(`[${chat.key}] 发送表情包：${item.id} ${item.desc || item.note || ''}`);
    return { ok: true, messageId, id: item.id };
  }

  async autoAttachSticker(chat, text, { grudge = false } = {}) {
    const cfg = this.config.sticker;
    if (!cfg?.enabled || cfg.autoSend === false) return null;
    if (chat.sentStickerDuringTurn) return null;
    if (!text && !chat.sentDuringTurn) return null;
    const now = Date.now();
    if (now - (chat.lastAutoStickerAt || 0) < (cfg.minGapMs || 45000)) return null;
    chat.stickerTimes = (chat.stickerTimes || []).filter((ts) => now - ts < 3600000);
    if (chat.stickerTimes.length >= (cfg.maxPerHour || 10)) return null;
    const probability = grudge ? (cfg.grudgeProbability ?? 0.75) : (cfg.attachProbability ?? 0.45);
    if (Math.random() > probability) return null;
    const item = this.stickerStore.pick({ text, grudge, recent: chat.recentStickers || [] });
    if (!item) return null;
    await new Promise((resolve) => setTimeout(resolve, 600));
    try {
      return await this.sendStickerToChat(chat, item);
    } catch (error) {
      this.log.warn(`自动发表情包失败：${error.message}`);
      return null;
    }
  }

  async toolCollectSticker({ token, messageId, note }) {
    const chat = this.chatByToken(token);
    const item = chat.messages.find((m) => String(m.messageId) === String(messageId));
    if (!item?.images?.length) throw new Error('这条消息没有图片');
    const media = await this.downloadImage(item.images[0]);
    const dir = path.join(this.config.paths.media, 'stickers');
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.createHash('sha1').update(media.buffer).digest('hex').slice(0, 12);
    const file = path.join(dir, `${id}.${media.ext}`);
    fs.writeFileSync(file, media.buffer);
    const sticker = this.stickerStore.add({ file, note: String(note || '').slice(0, 40), source: 'agent', id });
    this.enqueueRecognize(id);
    return { ok: true, id, file, sticker };
  }

  toolListStickers({ limit = 30 }) {
    return { items: this.stickerStore.list(limit), stats: this.stickerStore.stats() };
  }

  toolStickerNote({ id, desc, emotion, tags, usage, note }) {
    const item = this.stickerStore.update(id, { desc, emotion, tags, usage, note });
    return { ok: true, item };
  }

  async toolSendSticker({ token, id, replyToMessageId }) {
    const chat = this.chatByToken(token);
    const item = this.stickerStore.get(id);
    if (!item) throw new Error(`表情不存在：${id}`);
    if (item.disabled) throw new Error(`表情 ${id} 已被拉黑（永不录用），换一个`);
    chat.sentStickerDuringTurn = true;
    return this.sendStickerToChat(chat, item, { replyToMessageId });
  }

  /** 给 agent 用的拉黑/恢复入口。 */
  async toolStickerBan({ id, disabled = true }) {
    return this.stickerSetDisabled(id, disabled !== false);
  }

  async toolGetImages({ token, messageId, limit = 4 }) {
    const chat = this.chatByToken(token);
    const item = chat.messages.find((m) => String(m.messageId) === String(messageId));
    if (!item) throw new Error(`没有找到消息 ${messageId}`);
    let images = item.images || [];
    if (!images.length && item.messageId) {
      try {
        const detail = await this.onebot.getMessage(item.messageId);
        const segments = Array.isArray(detail?.message) ? detail.message : [];
        images = segments.filter((s) => s.type === 'image').map((s) => ({ url: s.data?.url || '', file: s.data?.file || '' }));
      } catch {
        /* ignore */
      }
    }
    if (!images.length) throw new Error('这条消息没有图片');
    const out = [];
    for (const image of images.slice(0, clamp(limit, 1, 6))) {
      try {
        const media = await this.downloadImage(image);
        out.push({ mimeType: media.mime, data: media.buffer.toString('base64'), bytes: media.buffer.length });
      } catch (error) {
        this.log.warn(`下载图片失败：${error.message}`);
      }
    }
    if (!out.length) throw new Error('图片下载失败（可能已过期）');
    return { images: out };
  }

  async downloadImage(image) {
    let url = image.url;
    if (!url && image.file) {
      if (/^https?:/i.test(image.file)) url = image.file;
      else if (fs.existsSync(image.file)) {
        const buffer = fs.readFileSync(image.file);
        const mime = mimeFromExt(image.file);
        return { buffer, mime, ext: path.extname(image.file).replace('.', '') || 'jpg' };
      }
    }
    if (!url) throw new Error('图片没有可下载的 URL');
    const { buffer, contentType } = await this._httpGetImage(url);
    const mime = String(contentType).split(';')[0].trim() || 'image/jpeg';
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[mime] || 'jpg';
    ensureDir(this.config.paths.media);
    return { buffer, mime, ext };
  }

  async _httpGetImage(url) {
    const { buffer, contentType } = await httpGet(url, {
      timeoutMs: 20000,
      maxBytes: 10 * 1024 * 1024,
      headers: { referer: 'https://q.qq.com/' },
    });
    return { buffer, contentType: contentType || 'image/jpeg' };
  }

  async toolGetForwardMsg({ token, id }) {
    this.chatByToken(token);
    const data = await this.onebot.getForwardMsg(id);
    return { id: String(id), text: this.flattenForward(data, 0), rawCount: Array.isArray(data?.messages) ? data.messages.length : undefined };
  }

  async toolTranscribeVoice({ token, messageId }) {
    const chat = this.chatByToken(token);
    const message = chat.messages.find((item) => String(item.messageId) === String(messageId));
    if (!message) throw new Error(`没有找到消息 ${messageId}`);
    const result = await transcribeMessage({ onebot: this.onebot, message, config: this.config, log: this.log });
    if (result.text) message.voiceText = result.text;
    return result;
  }

  toolRelationGet({ token, userId }) {
    const chat = this.chatByToken(token);
    if (userId) {
      const user = this.relations.get(chat.key, userId);
      if (!user) return { user: null, list: this.relations.list(chat.key) };
      return { user };
    }
    return { list: this.relations.list(chat.key), text: this.relations.render(chat.key) };
  }

  toolRelationSet({ token, userId, delta, note, tag }) {
    const chat = this.chatByToken(token);
    const user = this.relations.adjust(chat.key, userId, { delta: delta || 0, note: note || '', tag: tag || '' });
    return { ok: true, user };
  }

  toolDiaryRead({ token, date }) {
    if (date) {
      const day = this.diary.index.days[date];
      if (!day) throw new Error(`没有 ${date} 的日记`);
      if (!token) return { date, chats: Object.keys(day.chats) };
      const chat = this.chatByToken(token);
      const item = day.chats[chat.key];
      if (!item) throw new Error(`没有 ${date} 这个会话的日记`);
      return { date, ...item, text: fs.readFileSync(item.file, 'utf8') };
    }
    if (token) {
      const chat = this.chatByToken(token);
      return { recent: this.diary.recent(chat.key, 3), list: this.diary.listRecent(7) };
    }
    return { list: this.diary.listRecent(7) };
  }

  toolArchiveList({ token, date, limit = 30 }) {
    const chat = this.chatByToken(token);
    return { entries: this.archive.list(chat.key, { date: date || '', limit: clamp(limit, 1, 100) }), stats: this.archive.stats(chat.key) };
  }

  toolArchiveStats({ token }) {
    const chat = token ? this.chatByToken(token) : null;
    return { chat: chat ? this.archive.stats(chat.key) : null, global: this.archive.globalStats() };
  }

  async toolSetNickname({ nickname }) {
    const raw = String(nickname ?? '').replace(/[\r\n\t]/g, ' ').trim();
    const max = this.config.profile?.maxNicknameLength || 20;
    if (!raw) throw new Error('昵称不能为空');
    if (raw.length > max) throw new Error(`昵称最长 ${max} 个字符`);
    if (/^https?:\/\//i.test(raw)) throw new Error('昵称不能是链接');
    if (raw === this.onebot.nickname) return { ok: true, nickname: raw, changed: false };
    const file = path.join(this.config.paths.state, 'profile.json');
    const state = readJson(file, { lastNicknameAt: 0, history: [] });
    const cooldown = this.config.profile?.nicknameChangeCooldownMs ?? 3600000;
    const wait = cooldown - (Date.now() - (state.lastNicknameAt || 0));
    if (wait > 0) throw new Error(`改昵称太频繁，还要等 ${Math.ceil(wait / 60000)} 分钟`);
    const previous = this.onebot.nickname;
    try {
      await this.onebot.setNickname(raw);
    } catch (error) {
      throw new Error(`SnowLuma/OneBot 不支持 set_qq_profile：${error.message}`);
    }
    this.onebot.nickname = raw;
    state.lastNicknameAt = Date.now();
    state.history = [...(state.history || []), { from: previous, to: raw, at: Date.now() }].slice(-30);
    writeJsonAtomic(file, state);
    this.log.info(`QQ 昵称已修改：${previous} → ${raw}`);
    this.broadcastStatus();
    return { ok: true, nickname: raw, previous, changed: true };
  }

  async toolPlaySong({ token, query, replyToMessageId = '', sendAsVoice = true }) {
    const chat = this.chatByToken(token);
    if (!this.config.music?.enabled) throw new Error('点歌功能未启用');
    const q = String(query || '').trim();
    if (!q) throw new Error('query 不能为空');
    const { song } = await resolveSong(q, this.config, this.log.child('music'));
    const segments = [];
    if (replyToMessageId) segments.push(msg.reply(replyToMessageId));
    const wantVoice = sendAsVoice !== false && this.config.music?.sendAsVoice !== false;
    let voice = wantVoice;
    let messageId = '';
    if (!wantVoice) {
      const data = await this.onebot.sendMessage(chat, [...segments, msg.file(song.file, `${song.title}.mp3`)]);
      messageId = String(data?.message_id ?? '');
    } else {
      try {
        const data = await this.onebot.sendMessage(chat, [...segments, msg.record(song.file)]);
        messageId = String(data?.message_id ?? '');
      } catch (firstError) {
        try {
          const uri = `file:///${song.file.replace(/\\/g, '/').replace(/^\//, '')}`;
          const data = await this.onebot.sendMessage(chat, [...segments, msg.record(uri)]);
          messageId = String(data?.message_id ?? '');
        } catch (secondError) {
          voice = false;
          const data = await this.onebot.sendMessage(chat, [...segments, msg.file(song.file, `${song.title}.mp3`)]);
          messageId = String(data?.message_id ?? '');
          this.log.warn(`语音发送失败，已改发文件：${firstError.message} / ${secondError.message}`);
        }
      }
    }
    chat.sentDuringTurn = true;
    chat.sentThisTurn = (chat.sentThisTurn || 0) + 1;
    chat.lastSentAt = Date.now();
    this.recordSelfMessage(chat, {
      messageId,
      time: Date.now(),
      text: voice ? `[语音]《${song.title}》- ${song.artist}` : `[文件]《${song.title}》- ${song.artist}`,
      segments,
      images: [],
      replyId: replyToMessageId || '',
    });
    return {
      ok: true,
      title: song.title,
      artist: song.artist,
      album: song.album,
      source: song.source,
      duration: song.duration,
      file: song.file,
      bytes: song.bytes,
      voice,
      messageId,
    };
  }

  async toolPlayVideo({ token, query = '', url = '', replyToMessageId = '', sendAsFile = false }) {
    const chat = this.chatByToken(token);
    if (!this.config.video?.enabled) throw new Error('视频功能未启用');
    if (!String(query || '').trim() && !String(url || '').trim()) throw new Error('query 与 url 至少提供一个');
    const video = await resolveVideo({ query, url }, this.config, this.log.child('video'));
    const segments = [];
    if (replyToMessageId) segments.push(msg.reply(replyToMessageId));
    let asVideo = sendAsFile !== true;
    let messageId = '';
    let sendError = '';
    if (asVideo) {
      try {
        const data = await this.onebot.sendMessage(chat, [...segments, msg.video(video.file)]);
        messageId = String(data?.message_id ?? '');
      } catch (firstError) {
        try {
          const uri = `file:///${video.file.replace(/\\/g, '/').replace(/^\//, '')}`;
          const data = await this.onebot.sendMessage(chat, [...segments, msg.video(uri)]);
          messageId = String(data?.message_id ?? '');
        } catch (secondError) {
          asVideo = false;
          sendError = `${firstError.message} / ${secondError.message}`;
        }
      }
    }
    if (!asVideo) {
      const data = await this.onebot.sendMessage(chat, [...segments, msg.file(video.file, `${video.title}.mp4`)]);
      messageId = String(data?.message_id ?? '');
      if (sendError) this.log.warn(`视频发送失败，已改发文件：${sendError}`);
    }
    chat.sentDuringTurn = true;
    chat.sentThisTurn = (chat.sentThisTurn || 0) + 1;
    chat.lastSentAt = Date.now();
    this.recordSelfMessage(chat, {
      messageId,
      time: Date.now(),
      text: asVideo ? `[视频]《${video.title}》` : `[文件]《${video.title}》`,
      segments,
      images: [],
      replyId: replyToMessageId || '',
    });
    return {
      ok: true,
      title: video.title,
      uploader: video.uploader,
      source: video.source,
      duration: video.duration,
      file: video.file,
      bytes: video.bytes,
      video: asVideo,
      messageId,
    };
  }

  async toolReadWebsite({ url }) {
    return readWebPage(url, this.config);
  }

  async toolWebSearch({ query }) {
    return searchWeb(query, this.config);
  }

  async toolWebFetch({ url }) {
    return fetchWeb(url, this.config);
  }

  toolStatus() {
    const balance = readBalance(this.config, this.log);
    return {
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      snowluma: {
        connected: this.onebot.connected,
        httpUrl: this.config.snowluma.httpUrl,
        wsUrl: this.config.snowluma.wsUrl,
        selfId: this.onebot.selfId,
        nickname: this.onebot.nickname,
        stats: this.onebot.stats,
      },
      dsh: {
        ready: this.dshReady,
        command: this.config.dsh.command,
        profile: this.config.dsh.profile,
        model: this.config.dsh.model,
        patch: this.config.paths.patch,
        ownerReady: this.ownerDshReady,
        ownerPatch: this.config.paths.ownerPatch,
      },
      balance: { ...balance, text: formatBalance(balance) },
      usage: { totals: this.usage.summary().totals, today: Number(this.usage.costToday().toFixed(4)) },
      chats: [...this.chats.values()].map((chat) => ({
        ...publicChat(chat),
        relations: this.relations.summary(chat.key),
        archive: this.archive.stats(chat.key),
        diary: this.diary.recent(chat.key, 1)?.date || '',
      })),
      extensions: {
        archive: this.archive.globalStats(),
        diary: this.diary.listRecent(7),
        proactive: this.config.proactive,
        audit: this.audit.slice(-20),
        thinkings: this.thinkings.slice(-30),
        stickers: this.stickerStore.stats(),
        avatar: avatarState(this.config).state.current,
        socialConfig: {
          grudgeKeywords: this.config.wake.grudgeKeywords,
          autoState: this.config.wake.autoState,
          joinProbability: this.config.wake.joinProbability,
          coolingMs: this.config.wake.coolingMs,
        },
      },
      logs: this.log.tail(80),
    };
  }

  whitelistInfo() {
    const allow = this.config.qq.allow || {};
    const deny = this.config.qq.deny || {};
    return {
      ownerQQ: this.config.qq.ownerQQ || null,
      allow: {
        private: [...(allow.private || [])].map(String),
        groups: [...(allow.groups || [])].map(String),
      },
      deny: {
        private: [...(deny.private || [])].map(String),
        groups: [...(deny.groups || [])].map(String),
      },
      allowAllWhenEmpty: !!this.config.qq.allowAllWhenEmpty,
    };
  }

  addWhitelist(kind, id) {
    return this._changeWhitelist('add', kind, id);
  }

  removeWhitelist(kind, id) {
    return this._changeWhitelist('remove', kind, id);
  }

  _changeWhitelist(action, kind, id) {
    const listName = kind === 'group' ? 'groups' : kind === 'private' ? 'private' : '';
    if (!listName) throw new Error('kind 只能是 group 或 private');
    const value = String(id ?? '').trim();
    if (!/^\d{5,15}$/.test(value)) throw new Error('QQ 号/群号必须是 5~15 位数字');
    if (!this.config.qq.allow) this.config.qq.allow = { private: [], groups: [] };
    const list = [...(this.config.qq.allow[listName] || [])].map(String);
    const exists = list.includes(value);
    let next;
    if (action === 'add') {
      if (exists) return { ...this.whitelistInfo(), changed: false };
      next = [...list, value];
    } else {
      if (!exists) return { ...this.whitelistInfo(), changed: false };
      next = list.filter((item) => item !== value);
    }
    this.config.qq.allow[listName] = next;

    // 同步写回 config.json（保留其它配置）
    try {
      const file = this.config.paths.config;
      const current = readJson(file, {});
      current.qq ||= {};
      current.qq.allow ||= { private: [], groups: [] };
      current.qq.allow.private = [...(this.config.qq.allow.private || [])].map(String);
      current.qq.allow.groups = [...(this.config.qq.allow.groups || [])].map(String);
      writeJsonAtomic(file, current);
    } catch (error) {
      this.log.error(`保存白名单失败：${error.message}`);
      throw new Error(`白名单已在内存生效，但写回 config.json 失败：${error.message}`);
    }

    const label = kind === 'group' ? '群聊' : '私聊';
    this.log.info(`${action === 'add' ? '加入' : '移除'}白名单${label}：${value}`);
    this.recordAudit({ tool: `whitelist.${action}`, ok: true, ms: 0, params: `${kind}:${value}` });
    this.broadcastStatus();
    return { ...this.whitelistInfo(), changed: true };
  }

  toolChats() {
    return {
      chats: [...this.chats.values()].map((chat) => ({
        ...publicChat(chat),
        relations: this.relations.summary(chat.key),
        archive: this.archive.stats(chat.key),
        diary: this.diary.recent(chat.key, 1)?.date || '',
      })),
    };
  }

  toolResetSession({ token }) {
    const chat = this.chatByToken(token);
    chat.sessionId = `session-qq-${chat.kind}-${crypto.randomBytes(5).toString('hex')}`;
    chat.sessionReady = false;
    chat.readSeq = chat.lastSeq;
    chat.seenSeq = chat.lastSeq;
    this.saveState();
    return { ok: true, sessionId: chat.sessionId };
  }

  toolSetChatWake({ key, config }) {
    const chat = this.chats.get(key);
    if (!chat) throw new Error(`没有会话 ${key}`);
    chat.wake = buildWakeConfig(chat.wake, config || {});
    this.saveState();
    return { ok: true, chat: publicChat(chat) };
  }

  toolSendTest({ key, text }) {
    const chat = this.chats.get(key);
    if (!chat) throw new Error(`没有会话 ${key}`);
    return this.sendText(chat, text, { source: 'console' });
  }

  broadcastStatus() {
    this.emit('status', this.toolStatus());
  }

  async stop() {
    this.stopSchedulers();
    if (this.control) await this.control.stop();
    this.onebot.close();
    if (this.dsh) await this.dsh.shutdown();
    if (this.ownerDsh) await this.ownerDsh.shutdown();
    this.saveState();
  }
}

function summarizeToolArgs(tool, params) {
  try {
    const p = params || {};
    if (tool === 'send_message' || tool === 'reply') {
      const text = Array.isArray(p.messages) ? p.messages.join(' / ') : p.messages;
      return truncate(String(text || ''), 80);
    }
    if (tool === 'recall_message') return `撤回 ${p.messageId}${p.taunt ? ` + 嘲讽「${truncate(p.taunt, 30)}」` : ''}`;
    if (tool === 'mute_member') return `禁言 ${p.userId} ${p.durationSeconds || '默认'} 秒${p.taunt ? ` + 嘲讽` : ''}`;
    if (tool === 'set_wake_config') return truncate(JSON.stringify(p.config || {}), 80);
    if (tool === 'relation_set') return `${p.userId} delta=${p.delta || 0} ${p.note || ''}`;
    if (tool === 'memory_append') return truncate(`${p.kind}:${p.text}`, 80);
    return truncate(JSON.stringify(p), 80);
  } catch {
    return '';
  }
}

function publicMessage(item) {
  return {
    seq: item.seq,
    messageId: item.messageId,
    time: item.time,
    userId: item.userId,
    nickname: item.sender?.nickname || String(item.userId),
    role: item.sender?.role || 'member',
    text: item.text,
    images: (item.images || []).length,
    forwards: (item.forwards || []).map((f) => f.id),
    voices: (item.voices || []).length,
    files: (item.files || []).map((f) => f.name),
    voiceText: item.voiceText || '',
    forwardText: item.forwardText || '',
    replyId: item.replyId || '',
    self: !!item.self,
    atSelf: !!item.atSelf,
  };
}

function publicChat(chat) {
  return {
    key: chat.key,
    kind: chat.kind,
    targetId: chat.targetId,
    name: chat.name,
    token: chat.token,
    sessionId: chat.sessionId,
    readSeq: chat.readSeq,
    lastSeq: chat.lastSeq,
    unread: chat.messages.filter((m) => m.seq > chat.readSeq && !m.self).length,
    running: chat.running,
    wake: chat.wake,
    wakeText: describeWake(chat.wake),
    social: chat.social ? {
      state: chat.social.state,
      coolingUntil: chat.social.coolingUntil || 0,
      lastJoinAt: chat.social.lastJoinAt || 0,
      autoState: chat.social.autoState !== false,
      log: (chat.social.log || []).slice(-8),
    } : null,
    thinking: chat.running && chat.liveTrace
      ? { at: Date.now(), trigger: chat.currentWake || '思考中', grudge: !!chat.currentGrudge, autoJoin: !!chat.pendingAutoJoin, trace: chat.liveTrace, reasoning: '', text: chat.liveTrace, live: true }
      : (chat.lastThinking || null),
    thinkings: (chat.thinkings || []).slice(-5),
    selfRole: chat.selfRole,
    lastMessageAt: chat.messages[chat.messages.length - 1]?.time || 0,
    messages: chat.messages.slice(-20).map(publicMessage),
  };
}

function mimeFromExt(file) {
  const ext = path.extname(file).toLowerCase();
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'image/jpeg';
}

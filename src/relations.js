import path from 'node:path';
import { readJson, writeJsonAtomic, truncate, clamp } from './util.js';
import { analyzeHostility } from './admin.js';

const PRAISE = /厉害|可爱|喜欢|谢谢|大佬|牛|强|靠谱|辛苦了|好评/;
const TAG_RULES = [
  { tag: '常聊', test: (u) => u.count >= 30 },
  { tag: '活跃', test: (u) => u.count >= 10 },
  { tag: '嘴臭', test: (u) => u.insults >= 3 },
  { tag: '嘴甜', test: (u) => u.praises >= 3 },
  { tag: '夜猫子', test: (u) => u.night >= 10 },
];

/**
 * 轻量好感度/关系：只统计可解释的行为，不调用模型。
 * 数值范围 -50..50；只是给提示词一个语气参考，不向群友暴露。
 */
export class RelationsStore {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.dir = path.join(config.paths.state, 'relations');
    this.cache = new Map();
    this.saveTimers = new Map();
  }

  file(chatKey) {
    return path.join(this.dir, `${chatKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }

  load(chatKey) {
    if (this.cache.has(chatKey)) return this.cache.get(chatKey);
    const data = readJson(this.file(chatKey), null) || { users: {}, updatedAt: 0 };
    data.users ||= {};
    this.cache.set(chatKey, data);
    return data;
  }

  scheduleSave(chatKey) {
    if (this.saveTimers.has(chatKey)) return;
    const timer = setTimeout(() => {
      this.saveTimers.delete(chatKey);
      try {
        const data = this.load(chatKey);
        const entries = Object.entries(data.users).sort((a, b) => b[1].lastAt - a[1].lastAt).slice(0, this.config.relations?.maxUsers || 300);
        data.users = Object.fromEntries(entries);
        writeJsonAtomic(this.file(chatKey), data);
      } catch (error) {
        this.log?.warn?.(`保存关系失败：${error.message}`);
      }
    }, 2000);
    timer.unref?.();
    this.saveTimers.set(chatKey, timer);
  }

  ensure(data, userId, name) {
    const key = String(userId);
    const user = (data.users[key] ||= {
      userId: Number(userId),
      name: name || `QQ${userId}`,
      affinity: 0,
      count: 0,
      insults: 0,
      praises: 0,
      night: 0,
      tags: [],
      notes: [],
      firstAt: Date.now(),
      lastAt: 0,
    });
    if (name) user.name = name;
    return user;
  }

  observe(chatKey, message, { selfId } = {}) {
    if (!this.config.relations?.enabled) return null;
    if (!message?.userId || message.self) return null;
    const data = this.load(chatKey);
    const user = this.ensure(data, message.userId, message.sender?.nickname);
    const text = String(message.text || '');
    const now = Date.now();
    user.count += 1;
    user.lastAt = now;
    const hour = new Date().getHours();
    if (hour >= 0 && hour < 6) user.night += 1;
    let delta = 0.2;
    if (message.atSelf) delta += 0.4;
    if (message.replyId && message.replyToSelf) delta += 0.4;
    if (PRAISE.test(text)) {
      delta += 1;
      user.praises += 1;
    }
    const hostile = analyzeHostility(text);
    if (hostile.hostile) {
      delta -= 3.5;
      user.insults += 1;
    }
    user.affinity = clamp(user.affinity + delta, -50, 50);
    user.tags = TAG_RULES.filter((rule) => rule.test(user)).map((rule) => rule.tag);
    if (hostile.hostile && user.notes.length < 5) {
      user.notes.push({ at: now, text: truncate(text, 60), kind: 'bad' });
    }
    this.scheduleSave(chatKey);
    return user;
  }

  get(chatKey, userId) {
    const data = this.load(chatKey);
    return data.users[String(userId)] || null;
  }

  list(chatKey, limit = 20) {
    const data = this.load(chatKey);
    return Object.values(data.users).sort((a, b) => b.lastAt - a.lastAt).slice(0, limit);
  }

  adjust(chatKey, userId, { delta = 0, note = '', tag = '' }) {
    const data = this.load(chatKey);
    const user = this.ensure(data, userId);
    user.affinity = clamp(user.affinity + clamp(delta, -5, 5), -50, 50);
    if (note) {
      user.notes.push({ at: Date.now(), text: truncate(note, 80), kind: 'note' });
      user.notes = user.notes.slice(-8);
    }
    if (tag && !user.tags.includes(tag)) user.tags.push(String(tag).slice(0, 12));
    this.scheduleSave(chatKey);
    return user;
  }

  bump(chatKey, userId, delta = 0.3) {
    if (!userId) return;
    const data = this.load(chatKey);
    const user = this.ensure(data, userId);
    user.affinity = clamp(user.affinity + delta, -50, 50);
    this.scheduleSave(chatKey);
  }

  render(chatKey, limit = 5) {
    const users = Object.values(this.load(chatKey).users).filter((u) => u.count >= 2);
    if (!users.length) return '';
    const positive = users.filter((u) => u.affinity >= 1.5).sort((a, b) => b.affinity - a.affinity).slice(0, limit);
    const negative = users.filter((u) => u.affinity <= -1.5).sort((a, b) => a.affinity - b.affinity).slice(0, limit);
    const lines = [];
    if (positive.length) lines.push(`聊得来：${positive.map((u) => `${u.name}(${Math.round(u.affinity)})`).join('、')}`);
    if (negative.length) lines.push(`有过节：${negative.map((u) => `${u.name}(${Math.round(u.affinity)})`).join('、')}`);
    return lines.join('；');
  }

  summary(chatKey) {
    const users = this.list(chatKey, 5);
    return {
      count: Object.keys(this.load(chatKey).users).length,
      top: users.map((u) => ({ userId: u.userId, name: u.name, affinity: Math.round(u.affinity), tags: u.tags, count: u.count })),
    };
  }
}

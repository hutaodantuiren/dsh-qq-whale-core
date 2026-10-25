import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJsonAtomic, ensureDir, truncate } from './util.js';

const ANGRY = /生气|愤怒|无语|翻白眼|嘲讽|嫌弃|鄙视|恼|气|哼|白眼|拳头|怒/;
const CUTE = /可爱|开心|笑|赞|比心|贴贴|抱抱|喜欢|萌|猫|鲸鱼/;

/**
 * 本地表情包库。图片在 state/media/stickers，元数据在 state/stickers.json。
 * 识别结果（desc/emotion/tags）用于按语境自动挑图。
 */
export class StickerStore {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.file = path.join(config.paths.state, 'stickers.json');
    this.dir = path.join(config.paths.media, 'stickers');
    this.data = readJson(this.file, null) || { items: {} };
    this.data.items ||= {};
    this.saveTimer = null;
    this._migrate();
  }

  _migrate() {
    for (const [id, item] of Object.entries(this.data.items)) {
      item.id ||= id;
      item.tags ||= [];
      item.desc ||= item.note || '';
      item.emotion ||= '';
      item.usage ||= '';
      item.source ||= 'unknown';
      item.recognized = item.recognized === true;
      item.useCount ||= 0;
      item.disabled = item.disabled === true;
    }
  }

  get(id) {
    return this.data.items[String(id)] || null;
  }

  list(limit = 50) {
    return Object.values(this.data.items).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
  }

  count() {
    return Object.keys(this.data.items).length;
  }

  /** 拉黑/恢复：拉黑后自动配图和显式发送都不会再用它。 */
  setDisabled(id, disabled = true) {
    const item = this.get(id);
    if (!item) throw new Error(`表情包不存在：${id}`);
    item.disabled = !!disabled;
    item.disabledAt = disabled ? Date.now() : 0;
    item.updatedAt = Date.now();
    this.scheduleSave();
    this.log?.info?.(`表情包${disabled ? '拉黑' : '恢复'}：${id}`);
    return item;
  }

  add({ file, note = '', desc = '', emotion = '', tags = [], usage = '', source = 'agent', id = '' }) {
    if (!file || !fs.existsSync(file)) return null;
    const buffer = fs.readFileSync(file);
    const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
    const key = id || hash;
    if (this.data.items[key]) {
      const existing = this.data.items[key];
      if (note && !existing.note) existing.note = truncate(note, 40);
      if (desc && !existing.desc) existing.desc = truncate(desc, 200);
      if (tags.length) existing.tags = [...new Set([...(existing.tags || []), ...tags])].slice(0, 10);
      this.scheduleSave();
      return existing;
    }
    if (this.count() >= (this.config.sticker?.maxItems || 300)) return null;
    const item = {
      id: key,
      file,
      note: truncate(note, 40),
      desc: truncate(desc, 200),
      emotion: truncate(emotion, 30),
      tags: [...new Set(tags.map((tag) => String(tag).slice(0, 12)))].slice(0, 10),
      usage: truncate(usage, 120),
      source,
      recognized: !!desc,
      at: Date.now(),
      useCount: 0,
      lastUsedAt: 0,
    };
    this.data.items[key] = item;
    this.scheduleSave();
    this.log?.info?.(`表情包入库：${key}（${source}）${item.desc ? ` ${item.desc}` : ''}`);
    return item;
  }

  update(id, patch = {}) {
    const item = this.get(id);
    if (!item) throw new Error(`表情包不存在：${id}`);
    for (const key of ['note', 'desc', 'emotion', 'usage']) {
      if (patch[key] !== undefined) item[key] = truncate(String(patch[key]), key === 'desc' ? 200 : 120);
    }
    if (Array.isArray(patch.tags)) item.tags = [...new Set(patch.tags.map((tag) => String(tag).slice(0, 12)))].slice(0, 10);
    if (patch.recognized !== undefined) item.recognized = !!patch.recognized;
    item.updatedAt = Date.now();
    this.scheduleSave();
    return item;
  }

  markUsed(id) {
    const item = this.get(id);
    if (!item) return;
    item.useCount = (item.useCount || 0) + 1;
    item.lastUsedAt = Date.now();
    this.scheduleSave();
  }

  pick({ text = '', grudge = false, recent = [] } = {}) {
    const items = Object.values(this.data.items).filter((item) => !item.disabled && fs.existsSync(item.file));
    if (!items.length) return null;
    const recentSet = new Set(recent.map(String));
    let best = null;
    let bestScore = -Infinity;
    for (const item of items) {
      let score = Math.random() * 1.2;
      if (recentSet.has(String(item.id))) score -= 8;
      const haystack = `${item.desc} ${item.note} ${item.emotion} ${item.tags.join(' ')} ${item.usage}`;
      if (grudge) {
        if (ANGRY.test(haystack)) score += 6;
        if (CUTE.test(haystack)) score -= 1;
      } else {
        if (CUTE.test(haystack)) score += 2;
        if (ANGRY.test(haystack)) score -= 0.5;
      }
      for (const tag of item.tags || []) {
        if (tag && tag.length >= 2 && text.includes(tag)) score += 2.5;
      }
      if (item.emotion && text.includes(item.emotion)) score += 2;
      if (item.desc && text.includes(item.desc.slice(0, 4))) score += 1;
      if (!item.recognized && !item.note) score -= 0.8;
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return best;
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 1000);
    this.saveTimer.unref?.();
  }

  save() {
    ensureDir(path.dirname(this.file));
    writeJsonAtomic(this.file, this.data);
  }

  stats() {
    const items = Object.values(this.data.items);
    return {
      total: items.length,
      recognized: items.filter((item) => item.recognized).length,
      web: items.filter((item) => item.source === 'web').length,
      used: items.filter((item) => item.useCount > 0).length,
      disabled: items.filter((item) => item.disabled).length,
      dir: this.dir,
    };
  }
}

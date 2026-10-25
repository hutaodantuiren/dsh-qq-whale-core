import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir, truncate } from './util.js';
import { httpGet } from './web.js';

const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' };

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class ArchiveStore {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.dir = path.resolve(config.paths.root, config.archive?.dir || 'state/archive');
    this.queue = [];
    this.running = false;
    this.seen = new Set();
    this.counts = new Map();
    this.entries = [];
    this.indexFile = path.join(this.dir, 'index.jsonl');
    this._loadIndex();
  }

  _loadIndex() {
    try {
      const text = fs.readFileSync(this.indexFile, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          this.entries.push(entry);
          this.seen.add(`${entry.messageId}:${entry.kind}:${entry.index}`);
          const key = `${entry.chat}:${entry.day}`;
          this.counts.set(key, (this.counts.get(key) || 0) + 1);
        } catch {
          /* ignore */
        }
      }
      if (this.entries.length > 5000) this.entries = this.entries.slice(-5000);
    } catch {
      /* no index yet */
    }
  }

  enqueue(chat, message) {
    if (!this.config.archive?.enabled) return;
    if (this.config.archive.images !== false) {
      for (const [index, image] of (message.images || []).entries()) {
        this._push({ chat, message, kind: 'image', index, url: image.url, file: image.file });
      }
    }
    if (this.config.archive.files !== false) {
      for (const [index, file] of (message.files || []).entries()) {
        this._push({ chat, message, kind: 'file', index, url: file.url, file: file.file, name: file.name, size: file.size });
      }
    }
  }

  recordNotice(chat, { messageId, userId, nickname, name, url, size, kind = 'file' }) {
    if (!this.config.archive?.enabled || !url) return;
    this._push({ chat, message: { messageId, userId, sender: { nickname }, text: '' }, kind, index: 0, url, name, size });
  }

  _push(item) {
    if (this.queue.length > 500) return;
    const key = `${item.message.messageId}:${item.kind}:${item.index}`;
    if (this.seen.has(key)) return;
    const day = dayKey(item.message.time);
    const countKey = `${item.chat.key}:${day}`;
    if ((this.counts.get(countKey) || 0) >= (this.config.archive.maxPerDay || 200)) return;
    this.seen.add(key);
    this.queue.push({ ...item, day, key, countKey });
    this.kick();
  }

  kick() {
    if (this.running) return;
    this.running = true;
    this.process().finally(() => {
      this.running = false;
      if (this.queue.length) this.kick();
    });
  }

  async process() {
    while (this.queue.length) {
      const item = this.queue.shift();
      try {
        await this.download(item);
      } catch (error) {
        this.log?.warn?.(`归档失败 ${item.key}：${error.message}`);
      }
    }
  }

  async download(item) {
    let url = item.url;
    if (!url && item.file && /^https?:/i.test(item.file)) url = item.file;
    if (!url) return;
    const { buffer, contentType } = await httpGet(url, {
      timeoutMs: 30000,
      maxBytes: this.config.archive.maxBytes || 10 * 1024 * 1024,
    });
    const mime = String(contentType).split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    const ext = IMAGE_EXT[mime] || (item.name ? path.extname(item.name).replace('.', '') : '') || 'bin';
    const dir = path.join(this.dir, item.chat.key.replace(/[^a-zA-Z0-9_-]/g, '_'), item.day);
    ensureDir(dir);
    const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
    const file = path.join(dir, `${String(item.message.messageId || hash).replace(/[^a-zA-Z0-9_-]/g, '_')}-${item.index}-${hash}.${ext}`);
    fs.writeFileSync(file, buffer);
    const entry = {
      ts: Date.now(),
      day: item.day,
      chat: item.chat.key,
      kind: item.kind,
      messageId: String(item.message.messageId || ''),
      userId: item.message.userId,
      nickname: item.message.sender?.nickname || String(item.message.userId || ''),
      file,
      url,
      bytes: buffer.length,
      mime,
      name: item.name || '',
      text: truncate(item.message.text || '', 120),
      index: item.index,
    };
    ensureDir(this.dir);
    fs.appendFileSync(this.indexFile, `${JSON.stringify(entry)}\n`, 'utf8');
    this.entries.push(entry);
    if (this.entries.length > 5000) this.entries.shift();
    this.counts.set(item.countKey, (this.counts.get(item.countKey) || 0) + 1);
    this.log?.info?.(`已归档 ${item.kind}：${file}`);
  }

  list(chatKey, { date = '', limit = 50 } = {}) {
    return this.entries
      .filter((entry) => entry.chat === chatKey && (!date || entry.day === date))
      .slice(-limit)
      .reverse();
  }

  stats(chatKey) {
    const entries = this.entries.filter((entry) => entry.chat === chatKey);
    const byDay = {};
    for (const entry of entries) byDay[entry.day] = (byDay[entry.day] || 0) + 1;
    return {
      total: entries.length,
      bytes: entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0),
      byDay: Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0])).slice(-14),
      recent: entries.slice(-8).reverse(),
      dir: this.dir,
      queued: this.queue.length,
    };
  }

  globalStats() {
    return {
      total: this.entries.length,
      bytes: this.entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0),
      queued: this.queue.length,
      dir: this.dir,
    };
  }
}

export { dayKey };

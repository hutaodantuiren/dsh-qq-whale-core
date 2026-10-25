import path from 'node:path';
import { readJson, writeJsonAtomic, truncate } from './util.js';

const LIMITS = { topics: 12, thoughts: 12, impressions: 40 };

export class MemoryStore {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.cache = new Map();
  }

  file(chatKey) {
    return path.join(this.config.paths.memory, `${chatKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }

  load(chatKey) {
    if (this.cache.has(chatKey)) return this.cache.get(chatKey);
    const data = readJson(this.file(chatKey), null) || { topics: [], thoughts: [], impressions: {}, updatedAt: 0 };
    data.topics ||= [];
    data.thoughts ||= [];
    data.impressions ||= {};
    this.cache.set(chatKey, data);
    return data;
  }

  save(chatKey, data) {
    data.updatedAt = Date.now();
    writeJsonAtomic(this.file(chatKey), data);
  }

  append(chatKey, { kind = 'topic', text, about = '' }) {
    const data = this.load(chatKey);
    const item = { text: truncate(String(text || '').trim(), 200), at: Date.now(), about: String(about || '').slice(0, 60) };
    if (!item.text) return null;
    if (kind === 'impression') {
      if (!item.about) return null;
      data.impressions[item.about] = { text: item.text, at: item.at };
    } else if (kind === 'thought') {
      data.thoughts.push(item);
      data.thoughts = data.thoughts.slice(-LIMITS.thoughts);
    } else {
      data.topics.push(item);
      data.topics = data.topics.slice(-LIMITS.topics);
    }
    this.save(chatKey, data);
    return item;
  }

  query(chatKey, term = '') {
    const data = this.load(chatKey);
    const needle = String(term || '').trim();
    const match = (item) => !needle || item.text.includes(needle) || (item.about || '').includes(needle);
    return {
      topics: data.topics.filter(match).slice(-8),
      thoughts: data.thoughts.filter(match).slice(-8),
      impressions: Object.entries(data.impressions)
        .filter(([name, value]) => !needle || name.includes(needle) || value.text.includes(needle))
        .slice(-12)
        .map(([name, value]) => ({ name, ...value })),
    };
  }

  remove(chatKey, { kind, text }) {
    const data = this.load(chatKey);
    const needle = String(text || '').trim();
    if (!needle) return 0;
    let removed = 0;
    if (kind === 'impression') {
      for (const key of Object.keys(data.impressions)) {
        if (key === needle || data.impressions[key].text.includes(needle)) {
          delete data.impressions[key];
          removed += 1;
        }
      }
    } else {
      const key = kind === 'thought' ? 'thoughts' : 'topics';
      const before = data[key].length;
      data[key] = data[key].filter((item) => !item.text.includes(needle) && item.about !== needle);
      removed = before - data[key].length;
    }
    if (removed) this.save(chatKey, data);
    return removed;
  }

  clear(chatKey) {
    const data = { topics: [], thoughts: [], impressions: {}, updatedAt: Date.now() };
    this.cache.set(chatKey, data);
    this.save(chatKey, data);
  }

  render(chatKey) {
    const data = this.load(chatKey);
    const lines = [];
    if (data.topics.length) lines.push(`进行中的话题：${data.topics.slice(-4).map((t) => t.text).join('；')}`);
    if (data.thoughts.length) lines.push(`没说出口的话：${data.thoughts.slice(-3).map((t) => t.text).join('；')}`);
    const impressions = Object.entries(data.impressions).slice(-5).map(([name, v]) => `${name}：${v.text}`);
    if (impressions.length) lines.push(`对群友的印象：${impressions.join('；')}`);
    return lines.join('\n');
  }
}

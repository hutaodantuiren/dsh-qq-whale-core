import path from 'node:path';
import { readJson, writeJsonAtomic, truncate } from './util.js';

const STOPWORDS = new Set([
  '什么', '怎么', '这个', '那个', '就是', '不是', '没有', '可以', '知道', '觉得', '现在', '今天', '时候', '一个',
  '我们', '你们', '他们', '自己', '真的', '还是', '但是', '因为', '所以', '如果', '已经', '有点', '感觉', '然后',
  '哈哈', '哈哈哈', '呵呵', '一下', '两个', '这么', '那么', '东西', '事情', '问题', 'image', 'http', 'https',
]);

const CJK_RUN = /[\u4e00-\u9fa5]{2,8}/g;
const LATIN_RUN = /[a-zA-Z][a-zA-Z0-9_-]{1,15}/g;

export class SlangStore {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.dictFile = path.join(config.paths.state, 'slang.json');
    this.candidateFile = path.join(config.paths.state, 'slang-candidates.json');
    this.dict = readJson(this.dictFile, null) || { entries: {} };
    this.dict.entries ||= {};
    this.candidates = readJson(this.candidateFile, null) || {};
    this.saveTimer = null;
  }

  observe(message) {
    if (!this.config.slang?.enabled) return;
    const text = String(message.text || '');
    const terms = new Set();
    for (const match of text.matchAll(CJK_RUN)) {
      const term = match[0];
      if (term.length >= 2 && term.length <= 6 && !STOPWORDS.has(term)) terms.add(term);
    }
    for (const match of text.matchAll(LATIN_RUN)) {
      const term = match[0];
      if (term.length >= 2 && !STOPWORDS.has(term.toLowerCase())) terms.add(term);
    }
    for (const segment of message.segments || []) {
      if (segment.type === 'face' || segment.type === 'mface') terms.add(`[face:${segment.data.id || segment.data.summary || '?'}]`);
    }
    const now = Date.now();
    let changed = false;
    for (const term of terms) {
      const entry = (this.candidates[term] ||= { count: 0, lastAt: 0, examples: [] });
      entry.count += 1;
      entry.lastAt = now;
      if (entry.examples.length < 3 && text && !entry.examples.includes(truncate(text, 60))) {
        entry.examples.push(truncate(text, 60));
      }
      changed = true;
    }
    if (changed) this.scheduleSave();
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        const entries = Object.entries(this.candidates).sort((a, b) => b[1].lastAt - a[1].lastAt).slice(0, 1200);
        this.candidates = Object.fromEntries(entries);
        writeJsonAtomic(this.candidateFile, this.candidates);
        writeJsonAtomic(this.dictFile, this.dict);
      } catch (error) {
        this.log?.warn?.(`保存黑话失败：${error.message}`);
      }
    }, 3000);
    this.saveTimer.unref?.();
  }

  query(term) {
    const needle = String(term || '').trim();
    if (!needle) return { entry: null, candidates: [] };
    const exact = this.dict.entries[needle] || null;
    const related = Object.entries(this.dict.entries)
      .filter(([key]) => key.includes(needle) || (this.dict.entries[key].meaning || '').includes(needle))
      .slice(0, 5)
      .map(([key, value]) => ({ term: key, ...value }));
    const candidates = Object.entries(this.candidates)
      .filter(([key]) => key.includes(needle))
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([key, value]) => ({ term: key, count: value.count, examples: value.examples }));
    return { entry: exact, related, candidates };
  }

  submit({ term, meaning, usage = '', tags = [], source = 'agent' }) {
    const key = String(term || '').trim();
    if (!key) throw new Error('term 不能为空');
    const existing = this.dict.entries[key];
    const entry = {
      term: key,
      meaning: String(meaning || '').trim(),
      usage: String(usage || '').trim(),
      tags: Array.isArray(tags) ? tags.slice(0, 6).map(String) : [],
      source,
      count: (existing?.count || 0) + 1,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    if (!entry.meaning) throw new Error('meaning 不能为空');
    this.dict.entries[key] = entry;
    if (Object.keys(this.dict.entries).length > (this.config.slang?.maxEntries || 800)) {
      const keep = Object.entries(this.dict.entries)
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, this.config.slang.maxEntries || 800);
      this.dict.entries = Object.fromEntries(keep);
    }
    writeJsonAtomic(this.dictFile, this.dict);
    return entry;
  }

  hints(limit = 8) {
    const known = new Set(Object.keys(this.dict.entries));
    return Object.entries(this.candidates)
      .filter(([term, value]) => value.count >= (this.config.slang?.minCount || 2) && !known.has(term) && !term.includes('['))
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, limit)
      .map(([term, value]) => ({ term, count: value.count, examples: value.examples }));
  }

  list(limit = 40) {
    return Object.values(this.dict.entries)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }
}

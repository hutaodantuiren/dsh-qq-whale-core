import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic, clamp } from './util.js';

export function readBalance(config, log) {
  if (!config.balance?.enabled) return null;
  const file = config.balance.usageFile;
  try {
    const stat = fs.statSync(file);
    const data = readJson(file, null);
    if (!data) return null;
    return {
      balance: typeof data.lastBalance === 'number' ? data.lastBalance : null,
      todayUsage: typeof data.todayUsage === 'number' ? data.todayUsage : null,
      date: data.date || '',
      updatedAt: stat.mtimeMs,
      stale: Date.now() - stat.mtimeMs > 10 * 60 * 1000,
      currency: 'CNY',
      source: file,
    };
  } catch (error) {
    log?.debug?.(`读取余额失败：${error.message}`);
    return null;
  }
}

export function formatBalance(balance) {
  if (!balance || balance.balance === null) return '未知（DSH 尚未写入余额缓存）';
  const yuan = Number(balance.balance).toFixed(2);
  const today = balance.todayUsage === null ? '' : `，今日已用 ¥${Number(balance.todayUsage).toFixed(2)}`;
  const stale = balance.stale ? '（缓存可能不是最新）' : '';
  return `¥${yuan}${today}${stale}`;
}

export class UsageLedger {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.file = path.join(config.paths.state, 'usage.json');
    this.data = readJson(this.file, null) || { totals: {}, chats: {}, events: [] };
    this.saveTimer = null;
  }

  price(usage) {
    const p = this.config.pricing || {};
    const hit = Number(p.cacheHitPerM ?? 0.5);
    const miss = Number(p.cacheMissPerM ?? 2);
    const out = Number(p.outputPerM ?? 8);
    const input = Number(usage.inputTokens || 0);
    const cacheRead = Number(usage.cacheReadTokens || 0);
    const output = Number(usage.outputTokens || 0);
    const missTokens = Math.max(0, input - cacheRead);
    const cost = (cacheRead / 1e6) * hit + (missTokens / 1e6) * miss + (output / 1e6) * out;
    return { cost, missTokens, cacheRead, output };
  }

  record(chatKey, usage, model) {
    if (!usage) return null;
    const { cost, missTokens, cacheRead, output } = this.price(usage);
    const event = {
      ts: Date.now(),
      chat: chatKey,
      model: model || '',
      input: Number(usage.inputTokens || 0),
      cacheRead,
      cacheMiss: missTokens,
      output,
      cost: Number(cost.toFixed(6)),
    };
    this.data.events.push(event);
    if (this.data.events.length > 2000) this.data.events = this.data.events.slice(-1500);

    const totals = this.data.totals;
    totals.input = (totals.input || 0) + event.input;
    totals.cacheRead = (totals.cacheRead || 0) + cacheRead;
    totals.cacheMiss = (totals.cacheMiss || 0) + missTokens;
    totals.output = (totals.output || 0) + output;
    totals.cost = Number(((totals.cost || 0) + cost).toFixed(6));
    totals.turns = (totals.turns || 0) + 1;

    const chat = (this.data.chats[chatKey] ||= { input: 0, cacheRead: 0, cacheMiss: 0, output: 0, cost: 0, turns: 0 });
    chat.input += event.input;
    chat.cacheRead += cacheRead;
    chat.cacheMiss += missTokens;
    chat.output += output;
    chat.cost = Number((chat.cost + cost).toFixed(6));
    chat.turns += 1;
    chat.lastAt = Date.now();

    this.scheduleSave();
    return event;
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        writeJsonAtomic(this.file, this.data);
      } catch (error) {
        this.log?.warn?.(`保存用量失败：${error.message}`);
      }
    }, 2000);
    this.saveTimer.unref?.();
  }

  summary() {
    return {
      totals: this.data.totals,
      chats: this.data.chats,
      recent: this.data.events.slice(-30),
    };
  }

  costToday() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return this.data.events.filter((event) => event.ts >= start.getTime()).reduce((sum, event) => sum + event.cost, 0);
  }
}

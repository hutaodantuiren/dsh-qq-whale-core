import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, truncate, writeJsonAtomic } from './util.js';
import { analyzeHostility } from './admin.js';

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 小鲸鱼日记：本地规则生成，不额外调用模型。
 * 每天把群聊压缩成一篇短日记，供第二天捡话题，也可以发给主人。
 */
export class DiaryStore {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.dir = path.join(config.paths.workspace, 'diary');
    this.indexFile = path.join(config.paths.state, 'diary.json');
    this.index = readJson(this.indexFile, null) || { lastRun: '', days: {} };
    this.index.days ||= {};
  }

  generate(chat, messages, { relationsText = '', memoryText = '' } = {}) {
    const list = messages.filter((m) => !m.self).slice(-(this.config.diary?.maxMessages || 200));
    const users = new Map();
    let images = 0;
    let forwards = 0;
    let hostile = 0;
    for (const message of list) {
      const name = message.sender?.nickname || String(message.userId);
      users.set(name, (users.get(name) || 0) + 1);
      images += (message.images || []).length;
      forwards += (message.forwards || []).length;
      if (analyzeHostility(message.text || '').hostile) hostile += 1;
    }
    const topUsers = [...users.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const quotes = list
      .filter((m) => (m.text || '').length >= 6 && (m.text || '').length <= 60 && !/^(草|？|\?|6|乐|典)$/.test(m.text))
      .slice(-12)
      .sort((a, b) => (b.text || '').length - (a.text || '').length)
      .slice(0, 2);
    const date = dayKey();
    const title = chat.kind === 'group' ? `群 ${chat.targetId}${chat.name ? `「${chat.name}」` : ''}` : `私聊 ${chat.targetId}`;
    const lines = [];
    lines.push(`# ${date} · ${title}`);
    lines.push('');
    if (!list.length) {
      lines.push('今天群里一句话都没有，安静得像深海。');
    } else {
      lines.push(`今天群里一共 ${list.length} 条消息，${topUsers.map(([name, count]) => `${name}说了 ${count} 条`).join('，')}。`);
      const extras = [];
      if (images) extras.push(`图片 ${images} 张`);
      if (forwards) extras.push(`转发 ${forwards} 条`);
      if (extras.length) lines.push(`另外还有${extras.join('、')}。`);
      if (quotes.length) {
        lines.push('');
        lines.push('印象比较深的话：');
        for (const quote of quotes) lines.push(`> ${quote.sender?.nickname || quote.userId}：${truncate(quote.text, 80)}`);
      }
      lines.push('');
      if (hostile > 0) lines.push(`今天有人嘴我，记小本本上了。（${hostile} 次）`);
      else if (list.length < 5) lines.push('群里挺冷清的，我大部分时间在潜水。');
      else lines.push('总体还算热闹，接了几句，也潜水了一会儿。');
    }
    if (relationsText) lines.push('', `关系变化：${relationsText}`);
    if (memoryText) lines.push('', `还记得：${truncate(memoryText.replace(/\n/g, '；'), 200)}`);
    lines.push('', '—— 小鲸鱼');
    return { date, title, markdown: lines.join('\n'), stats: { messages: list.length, images, forwards, hostile, topUsers } };
  }

  save(date, chat, { markdown, stats, title }) {
    ensureDir(path.join(this.dir, date));
    const file = path.join(this.dir, date, `${chat.key.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`);
    fs.writeFileSync(file, markdown, 'utf8');
    const day = (this.index.days[date] ||= { chats: {} });
    day.chats[chat.key] = { file, title, stats, updatedAt: Date.now() };
    // 合并版
    const combined = path.join(this.dir, `${date}.md`);
    const parts = Object.values(day.chats).map((item) => `<!-- ${item.title} -->\n\n${fs.readFileSync(item.file, 'utf8')}`);
    fs.writeFileSync(combined, `# 小鲸鱼日记 · ${date}\n\n${parts.join('\n\n---\n\n')}\n`, 'utf8');
    this.index.lastRun = date;
    writeJsonAtomic(this.indexFile, this.index);
    return file;
  }

  recent(chatKey, days = 2) {
    const dates = Object.keys(this.index.days).sort().slice(-days);
    for (const date of dates.reverse()) {
      const item = this.index.days[date]?.chats?.[chatKey];
      if (item) return { date, ...item, text: truncate(fs.existsSync(item.file) ? fs.readFileSync(item.file, 'utf8') : '', 800) };
    }
    return null;
  }

  listRecent(days = 7) {
    return Object.keys(this.index.days)
      .sort()
      .slice(-days)
      .reverse()
      .map((date) => ({ date, chats: Object.keys(this.index.days[date].chats).length, file: path.join(this.dir, `${date}.md`) }));
  }
}

export { dayKey };

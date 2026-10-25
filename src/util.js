import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export function sha1(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}

export function randomToken(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

export function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function formatClock(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDateTime(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** QQ 上不能显示 Markdown，转成朴素文本。 */
export function stripMarkdown(input) {
  let text = String(input ?? '');
  text = text.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, '');
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/^\s*>\s?/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+[.)]\s+/gm, '');
  text = text.replace(/[*_~]{2,}/g, '');
  return text.trim();
}

/**
 * 把模型输出切成若干条 QQ 消息。优先按换行；单行过长时按句读切，且不会把
 * 同一句拆到两条里（实在超长才硬切）。
 */
export function splitOutgoing(text, maxChars = 500, maxParts = 8) {
  const clean = stripMarkdown(text).replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  const lines = clean.split('\n').map((line) => line.trim()).filter(Boolean);
  const parts = [];
  for (const line of lines) {
    if (line.length <= maxChars) {
      parts.push(line);
      continue;
    }
    const sentences = line.match(/[^。！？!?…；;]+[。！？!?…；;]*/g) || [line];
    let buf = '';
    for (const sentence of sentences) {
      if ((buf + sentence).length > maxChars && buf) {
        parts.push(buf);
        buf = '';
      }
      if (sentence.length > maxChars) {
        if (buf) {
          parts.push(buf);
          buf = '';
        }
        for (let i = 0; i < sentence.length; i += maxChars) parts.push(sentence.slice(i, i + maxChars));
      } else {
        buf += sentence;
      }
    }
    if (buf) parts.push(buf);
  }
  return parts.slice(0, maxParts);
}

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(base[key])) out[key] = deepMerge(base[key], value);
    else out[key] = value;
  }
  return out;
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function uniqueBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function jsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

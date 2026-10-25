import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic, ensureDir } from './util.js';
import { searchImageUrls, downloadImages, setAvatar } from './avatar.js';

const DEFAULT_QUERIES = [
  'DeepSeek 小鲸鱼 蓝色 头发 头像',
  '鲸鱼娘 蓝发 Q版 头像',
  '蓝色大肥鱼 鲸鱼 头像',
  'DeepSeek 鲸鱼 二次元 头像',
];

export function avatarState(config) {
  const file = path.join(config.paths.state, 'avatar.json');
  const state = readJson(file, null) || { lastRun: 0, current: null, history: [] };
  state.history ||= [];
  return { file, state };
}

/**
 * 上网找图 →（可选）让 DSH 视觉挑一张 → 尝试 set_qq_avatar。
 */
export async function autoChangeAvatar({ config, log, onebot, vision = null }) {
  const ac = config.avatar?.autoChange || {};
  const count = Math.max(1, Math.min(6, ac.count || 4));
  const queries = (ac.queries || DEFAULT_QUERIES).slice(0, 6);
  const urls = [];
  const errors = [];
  for (const query of queries) {
    try {
      const result = await searchImageUrls(query, count, log);
      urls.push(...result.urls);
    } catch (error) {
      errors.push(`${query}: ${error.message}`);
    }
  }
  if (!urls.length) throw new Error(`没有搜到头像候选${errors.length ? `：${errors[0]}` : ''}`);
  const { saved, errors: downloadErrors } = await downloadImages(urls, config.paths.avatars, config, log, count, {
    maxBytes: config.avatar?.maxBytes || 8 * 1024 * 1024,
  });
  if (!saved.length) throw new Error(`头像下载失败${downloadErrors.length ? `：${downloadErrors[0]}` : ''}`);

  let picked = saved[0];
  let reason = '默认选第一张';
  if (ac.useVision !== false && typeof vision === 'function') {
    try {
      const images = saved.map((item) => ({
        mimeType: item.mime,
        data: fs.readFileSync(item.path).toString('base64'),
      }));
      const answer = await vision(images, '从这些候选图里选一张最适合当 DeepSeek 小鲸鱼（蓝白配色、蓝发、鲸鱼尾巴、Q版/二次元）头像的图片，只输出 JSON：{"index":0,"reason":"一句话理由"}。index 从 0 开始。');
      const match = String(answer).match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        const index = Number(parsed.index);
        if (Number.isInteger(index) && index >= 0 && index < saved.length) {
          picked = saved[index];
          reason = String(parsed.reason || '').slice(0, 120);
        }
      }
    } catch (error) {
      log?.warn?.(`头像视觉挑选失败，使用第一张：${error.message}`);
      reason = `视觉挑选失败，默认第一张：${error.message}`;
    }
  }

  const set = await setAvatar(picked.path, onebot, log);
  const { file, state } = avatarState(config);
  state.lastRun = Date.now();
  state.current = {
    file: picked.path,
    url: picked.url,
    reason,
    set: set.ok,
    at: Date.now(),
  };
  state.history.push(state.current);
  state.history = state.history.slice(-30);
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, state);
  return { picked, set, reason, state, errors: [...errors, ...downloadErrors].slice(0, 5) };
}

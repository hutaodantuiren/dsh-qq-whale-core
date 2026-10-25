import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { httpGet, decodeEntities } from './web.js';

const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' };

export async function searchImageUrls(query, count = 4, log = null) {
  const q = String(query || 'DeepSeek 小鲸鱼 蓝色 头像 二次元').trim();
  const urls = [];
  const errors = [];
  try {
    const api = `https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&ct=201326592&is=&fp=result&word=${encodeURIComponent(q)}&pn=0&rn=${Math.max(10, count * 4)}`;
    const { buffer } = await httpGet(api, {
      timeoutMs: 15000,
      maxBytes: 3 * 1024 * 1024,
      headers: { referer: 'https://image.baidu.com/', accept: 'application/json,text/plain,*/*' },
    });
    const text = buffer.toString('utf8');
    try {
      const data = JSON.parse(text);
      for (const item of data.data || []) {
        const url = item.middleURL || item.thumbURL || item.hoverURL || item.objURL;
        if (url && /^https?:/i.test(url)) urls.push(url.replace(/\\\//g, '/'));
      }
    } catch {
      for (const match of text.matchAll(/"middleURL":"(https?:[^"]+)"/g)) urls.push(match[1].replace(/\\\//g, '/'));
    }
  } catch (error) {
    errors.push(`百度图片：${error.message}`);
  }
  if (urls.length < count) {
    try {
      const { buffer } = await httpGet(`https://cn.bing.com/images/search?q=${encodeURIComponent(q)}&first=1`, {
        timeoutMs: 15000,
        maxBytes: 3 * 1024 * 1024,
      });
      const html = buffer.toString('utf8');
      for (const match of html.matchAll(/murl&quot;:&quot;(https?:.*?)&quot;/g)) {
        urls.push(decodeEntities(match[1]).replace(/\\\//g, '/'));
      }
    } catch (error) {
      errors.push(`Bing 图片：${error.message}`);
    }
  }
  return { query: q, urls: [...new Set(urls)], errors };
}

export async function downloadImages(urls, targetDir, config, log, count = 4, { maxBytes = 8388608 } = {}) {
  fs.mkdirSync(targetDir, { recursive: true });
  const saved = [];
  const errors = [];
  for (const url of [...new Set(urls)].slice(0, Math.max(count * 4, 8))) {
    if (saved.length >= count) break;
    try {
      const { buffer, contentType } = await httpGet(url, {
        timeoutMs: 15000,
        maxBytes,
        headers: { referer: 'https://image.baidu.com/' },
      });
      const mime = String(contentType).split(';')[0].trim().toLowerCase();
      if (!mime.startsWith('image/')) continue;
      if (buffer.length < 2048) continue;
      const ext = IMAGE_EXT[mime] || 'jpg';
      const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
      const file = path.join(targetDir, `${hash}.${ext}`);
      fs.writeFileSync(file, buffer);
      saved.push({ path: file, url, mime, bytes: buffer.length, hash });
      log?.info?.(`已保存图片：${file}`);
    } catch (error) {
      errors.push(`下载失败：${error.message}`);
    }
  }
  return { saved, errors };
}

export async function findAvatars(query, config, log, count = 4) {
  if (!config.avatar?.enabled) throw new Error('头像功能未启用');
  const { query: q, urls, errors: searchErrors } = await searchImageUrls(query, count, log);
  if (!urls.length) throw new Error(`没有找到图片${searchErrors.length ? `（${searchErrors.join('；')}）` : ''}`);
  const { saved, errors } = await downloadImages(urls, config.paths.avatars, config, log, count, {
    maxBytes: config.avatar.maxBytes || 8 * 1024 * 1024,
  });
  if (!saved.length) throw new Error(`图片下载全部失败${errors.length ? `：${errors.slice(0, 3).join('；')}` : ''}`);
  return { query: q, candidates: saved.map(({ hash, ...rest }) => rest), errors: [...searchErrors, ...errors].slice(0, 3) };
}

export async function setAvatar(file, onebot, log) {
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
  const ext = path.extname(file).toLowerCase().replace('.', '');
  const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/jpeg';
  const base64 = fs.readFileSync(file).toString('base64');
  try {
    await onebot.setQQAvatar(`base64://${base64}`);
    return { ok: true, note: '已通过 OneBot set_qq_avatar 设置头像' };
  } catch (error) {
    log?.warn?.(`set_qq_avatar 失败：${error.message}`);
    return {
      ok: false,
      note: `当前 SnowLuma/OneBot 实现不支持 set_qq_avatar（${error.message}）。图片已保存在本机，可在 QQ 客户端手动设置。`,
      mime,
    };
  }
}

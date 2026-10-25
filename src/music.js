import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { httpGet } from './web.js';
import { ensureDir, readJson, writeJsonAtomic } from './util.js';
import { downloadViaSongPlugin } from './song-plugin.js';

const UA_REFERER = { referer: 'https://y.qq.com/', accept: 'application/json,text/plain,*/*' };

function normalizeQQSong(item) {
  const singers = Array.isArray(item.singer) ? item.singer.map((s) => s.name).filter(Boolean) : [];
  const mid = String(item.mid || item.songmid || item.file?.media_mid || '');
  return {
    source: 'qq',
    id: mid,
    mid,
    mediaMid: String(item.file?.media_mid || item.media_mid || mid),
    title: String(item.title || item.name || item.songname || '').trim(),
    artist: singers.join('/'),
    album: String(item.album?.name || item.albumname || ''),
    duration: Number(item.interval || 0),
    pay: Number(item.pay?.pay_play || 0),
  };
}

export function parseQQSearch(data) {
  const list = data?.data?.song?.list || data?.song?.list || [];
  return list.map(normalizeQQSong).filter((song) => song.mid && song.title);
}

export async function searchQQMusic(query, config) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query 不能为空');
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=8&w=${encodeURIComponent(q)}&format=json&cr=1&new_json=1&inCharset=utf8&outCharset=utf-8`;
  const { buffer } = await httpGet(url, {
    timeoutMs: config.music?.timeoutMs || 20000,
    maxBytes: 2 * 1024 * 1024,
    headers: UA_REFERER,
  });
  const data = JSON.parse(buffer.toString('utf8'));
  return parseQQSearch(data);
}

async function resolveQQUrl(song, config) {
  const guid = String(Math.floor(1000000000 + Math.random() * 8999999999));
  const payload = {
    req: { module: 'CDN.SrfCdnDispatchServer', method: 'GetCdnDispatch', param: { guid, calltype: 0, userip: '' } },
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: { guid, songmid: [song.mid], songtype: [0], uin: '0', loginflag: 1, platform: '20' },
    },
  };
  const { buffer } = await httpGet(`https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(JSON.stringify(payload))}`, {
    timeoutMs: config.music?.timeoutMs || 20000,
    maxBytes: 2 * 1024 * 1024,
    headers: UA_REFERER,
  });
  const data = JSON.parse(buffer.toString('utf8'));
  const info = data?.req_0?.data?.midurlinfo?.[0];
  const purl = info?.purl || '';
  if (!purl) return '';
  const sip = data?.req_0?.data?.sip?.[0] || 'https://dl.stream.qqmusic.qq.com/';
  return `${sip}${purl}`;
}

function normalizeNeteaseSong(item) {
  return {
    source: 'netease',
    id: String(item.id || ''),
    mid: String(item.id || ''),
    title: String(item.name || '').trim(),
    artist: (item.artists || item.ar || []).map((a) => a.name).filter(Boolean).join('/'),
    album: String(item.album?.name || item.al?.name || ''),
    duration: Math.round(Number(item.duration || item.dt || 0) / 1000),
    pay: 0,
  };
}

export function parseNeteaseSearch(data) {
  const list = data?.result?.songs || data?.songs || [];
  return list.map(normalizeNeteaseSong).filter((song) => song.id && song.title);
}

export async function searchNetease(query, config) {
  const q = String(query || '').trim();
  const { buffer } = await httpGet(`https://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=1&limit=8&offset=0`, {
    timeoutMs: config.music?.timeoutMs || 20000,
    maxBytes: 2 * 1024 * 1024,
    headers: { referer: 'https://music.163.com/', accept: 'application/json,text/plain,*/*' },
  });
  return parseNeteaseSearch(JSON.parse(buffer.toString('utf8')));
}

export async function searchSongs(query, config) {
  const errors = [];
  const songs = [];
  try {
    songs.push(...(await searchQQMusic(query, config)));
  } catch (error) {
    errors.push(`QQ音乐：${error.message}`);
  }
  if (songs.length < 3) {
    try {
      songs.push(...(await searchNetease(query, config)));
    } catch (error) {
      errors.push(`网易云：${error.message}`);
    }
  }
  const seen = new Set();
  const unique = songs.filter((song) => {
    const key = `${song.title}|${song.artist}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { songs: unique.slice(0, 10), errors };
}

function looksLikeAudio(buffer, contentType) {
  if (/audio\/|mpeg|octet-stream/i.test(contentType)) return true;
  if (buffer.length > 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true; // ID3
  return buffer.length > 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

async function download(url, config) {
  const { buffer, contentType } = await httpGet(url, {
    timeoutMs: config.music?.timeoutMs || 30000,
    maxBytes: config.music?.maxBytes || 15 * 1024 * 1024,
    headers: { referer: 'https://y.qq.com/', accept: 'audio/mpeg,audio/*,*/*' },
  });
  if (!looksLikeAudio(buffer, contentType)) throw new Error(`返回的不是音频（${contentType || 'unknown'}）`);
  return { buffer, contentType };
}

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.aac', '.wma']);

export function localMusicDirs(config) {
  const dirs = Array.isArray(config.music?.localDirs) && config.music.localDirs.length
    ? config.music.localDirs
    : [
        path.join(os.homedir(), 'Music', 'QQMusic'),
        path.join(os.homedir(), 'Music'),
        path.join(os.homedir(), 'Documents', 'QQMusic'),
        path.join(config.paths.media, 'music'),
      ];
  return [...new Set(dirs.map((dir) => path.resolve(dir)))].filter((dir) => fs.existsSync(dir));
}

function parseLocalName(file) {
  const base = path.basename(file, path.extname(file)).replace(/^\d+[._-]\s*/, '');
  const parts = base.split(/\s*-\s*/).filter(Boolean);
  if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(' - ') };
  return { artist: '', title: base };
}

function walkAudio(dir, out, maxFiles, depth = 0) {
  if (out.length >= maxFiles || depth > 4) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= maxFiles) break;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAudio(full, out, maxFiles, depth + 1);
    } else if (entry.isFile() && AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) {
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size < 20 * 1024 || stat.size > (configMaxBytes || 30 * 1024 * 1024)) continue;
      out.push({ file: full, bytes: stat.size, mtime: stat.mtimeMs, ...parseLocalName(full) });
    }
  }
}
let configMaxBytes = 30 * 1024 * 1024;

export function scanLocalMusic(config, log = null, force = false) {
  const dirs = localMusicDirs(config);
  if (!dirs.length) return [];
  const indexFile = path.join(config.paths.state, 'music-index.json');
  const ttl = (config.music?.localIndexMinutes || 10) * 60000;
  const cached = readJson(indexFile, null);
  if (!force && cached?.at && Date.now() - cached.at < ttl && Array.isArray(cached.items)) return cached.items;
  configMaxBytes = config.music?.maxBytes || 30 * 1024 * 1024;
  const items = [];
  const maxFiles = config.music?.localScanMaxFiles || 2000;
  for (const dir of dirs) walkAudio(dir, items, maxFiles);
  writeJsonAtomic(indexFile, { at: Date.now(), dirs, items });
  log?.info?.(`本地音乐库扫描：${items.length} 首（${dirs.join('；')}）`);
  return items;
}

export function searchLocalMusic(query, config, log = null) {
  const items = scanLocalMusic(config, log);
  const q = String(query || '').toLowerCase().trim();
  if (!q) return null;
  const tokens = q.split(/\s+/).filter((token) => token.length >= 1);
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const haystack = `${item.title} ${item.artist} ${path.basename(item.file)}`.toLowerCase();
    let score = 0;
    if (haystack.includes(q)) score += 10;
    for (const token of tokens) if (haystack.includes(token)) score += 2;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= 4 ? best : null;
}

export function songLink(song, query = '') {
  if (song?.source === 'qq' && song.mid) return `https://y.qq.com/n/ryqq/songDetail/${song.mid}`;
  if (song?.source === 'netease' && song.id) return `https://music.163.com/#/song?id=${song.id}`;
  return `https://y.qq.com/n/ryqq/search?w=${encodeURIComponent(query)}`;
}

/**
 * 搜索并下载一首可公开播放的歌。
 * 顺序：本机音乐库 → dsh-song-download 插件（B 站/YouTube + yt-dlp）→ QQ 音乐/网易云免费音源。
 * VIP/付费/版权受限的曲目会跳过，不绕过任何限制。
 */
export async function resolveSong(query, config, log) {
  const local = searchLocalMusic(query, config, log);
  if (local?.file && fs.existsSync(local.file)) {
    log?.info?.(`点歌命中本地音乐库：${local.artist ? `${local.artist} - ` : ''}${local.title}`);
    return {
      song: { source: 'local', id: local.file, mid: '', title: local.title, artist: local.artist, album: '', duration: 0, url: '', file: local.file, bytes: local.bytes, contentType: 'audio/mpeg', downloadedAt: Date.now() },
      candidates: [],
      errors: [],
    };
  }
  const order = Array.isArray(config.music?.providerOrder) ? config.music.providerOrder : ['local', 'plugin', 'qq', 'netease'];
  if (order.includes('plugin') && config.music?.plugin !== false) {
    try {
      const song = await downloadViaSongPlugin(query, config, log);
      return { song, candidates: [], errors: [] };
    } catch (error) {
      log?.warn?.(`插件点歌失败，回退 QQ/网易云：${error.message}`);
    }
  }
  const { songs, errors } = await searchSongs(query, config);
  if (!songs.length) throw new Error(`没有搜到歌曲${errors.length ? `（${errors.join('；')}）` : ''}。可以在这里搜：https://y.qq.com/n/ryqq/search?w=${encodeURIComponent(query)}`);
  const maxDuration = config.music?.maxDurationSec || 600;
  const q = String(query || '').toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = songs.map((song) => {
    const haystack = `${song.title} ${song.artist}`.toLowerCase();
    let score = 0;
    if (haystack.includes(q)) score += 8;
    let matched = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) { score += 2; matched += 1; }
    }
    return { song, score, matched };
  }).filter((item) => item.matched > 0 && item.score > 0)
    .sort((a, b) => b.score - a.score);
  const candidates = scored
    .map((item) => item.song)
    .filter((song) => !song.duration || song.duration <= maxDuration)
    .slice(0, 5);
  if (!candidates.length) {
    const link = `https://y.qq.com/n/ryqq/search?w=${encodeURIComponent(query)}`;
    throw new Error(`没有找到和「${query}」匹配的免费音源，可能要会员。可以点这里自己搜：${link}`);
  }
  let lastError = '';
  for (const song of candidates) {
    try {
      let url = '';
      if (song.source === 'qq') url = await resolveQQUrl(song, config);
      else url = `https://music.163.com/song/media/outer/url?id=${song.id}.mp3`;
      if (!url) {
        lastError = 'QQ音乐未返回可播放地址（可能是 VIP/版权限制）';
        continue;
      }
      const { buffer, contentType } = await download(url, config);
      const dir = path.join(config.paths.media, 'music');
      ensureDir(dir);
      const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
      const file = path.join(dir, `${hash}.mp3`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
      const result = {
        ...song,
        url,
        file,
        bytes: buffer.length,
        contentType,
        downloadedAt: Date.now(),
      };
      log?.info?.(`点歌下载完成：${song.title} - ${song.artist}（${Math.round(buffer.length / 1024)}KB）`);
      return { song: result, candidates: songs, errors };
    } catch (error) {
      lastError = error.message;
      log?.warn?.(`歌曲下载失败「${song.title}」：${error.message}`);
    }
  }
  const top = songs[0];
  const link = songLink(top, query);
  const label = top ? `《${top.title}》${top.artist ? ` - ${top.artist}` : ''}` : '这首歌';
  throw new Error(`${label} 没有可下载的免费音源${lastError ? `（${lastError}）` : ''}，可能要会员。直接点开听：${link}`);
}

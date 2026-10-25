/**
 * B 站视频搜索 + 下载（yt-dlp），供 QQ 群「发个视频」用。
 * 只取公开可访问的短视频，默认限时长/限分辨率/限体积，超了就如实报错，不做绕过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureDir, truncate } from './util.js';
import { runYtdlp, whichExecutable } from './ytdlp.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REF = 'https://www.bilibili.com/';
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.flv', '.mov', '.m4v']);

export function videoSettings(config) {
  const v = config.video || {};
  return {
    maxBytes: Number(v.maxBytes) || 60 * 1024 * 1024,
    maxDurationSec: Number(v.maxDurationSec) || 600,
    maxHeight: Number(v.maxHeight) || 720,
    timeoutMs: Number(v.timeoutMs) || 300000,
    dir: v.dir ? path.resolve(config.paths.root, v.dir) : path.join(config.paths.media, 'video'),
  };
}

function normalizeTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (/^BV[0-9A-Za-z]{10}$/i.test(raw)) return `https://www.bilibili.com/video/${raw}`;
  if (/^av\d+$/i.test(raw)) return `https://www.bilibili.com/video/${raw}`;
  if (/^(https?:)?\/\//i.test(raw)) return raw.startsWith('//') ? `https:${raw}` : raw;
  return '';
}

/** 搜索结果按匹配度排序（中文按二字片段模糊匹配），返回候选列表。 */
export function rankVideos(entries, query, maxDurationSec = 0) {
  const q = String(query || '').toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const entry of entries || []) {
    const target = entry?.webpage_url || entry?.url || '';
    if (!target) continue;
    const hay = `${entry.title || ''} ${entry.uploader || ''}`.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (hay.includes(token)) {
        score += 4;
      } else {
        for (let i = 0; i + 1 < token.length; i += 1) {
          if (hay.includes(token.slice(i, i + 2))) score += 1;
        }
      }
    }
    if (tokens.length && score === 0) continue;
    if (/bilibili/i.test(`${entry.ie_key || ''} ${target}`)) score += 1;
    const duration = Number(entry.duration) || 0;
    if (maxDurationSec && duration && duration > maxDurationSec) continue;
    scored.push({ entry, score, duration });
  }
  scored.sort((a, b) => b.score - a.score || a.duration - b.duration);
  return scored.map((item) => item.entry);
}

/** 挑一条最合适的视频（rankVideos 的第一条）。 */
export function pickVideo(entries, query, maxDurationSec = 0) {
  return rankVideos(entries, query, maxDurationSec)[0] || null;
}

export async function searchVideos(query, config) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query 不能为空');
  const r = await runYtdlp(
    config,
    ['--no-warnings', '-J', `bilisearch8:${q}`, '--user-agent', UA, '--referer', REF],
    { timeoutMs: Number(config.video?.searchTimeoutMs) || 60000 },
  );
  if (r.code !== 0) throw new Error(`B 站搜索失败：${truncate(r.stderr.trim().split('\n').slice(-3).join(' '), 300)}`);
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    throw new Error('B 站搜索结果解析失败');
  }
  const entries = Array.isArray(data.entries) ? data.entries : [data];
  return entries.filter((entry) => entry && (entry.webpage_url || entry.url));
}

function probeDuration(file) {
  const ffprobe = whichExecutable('ffprobe');
  if (!ffprobe) return 0;
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  const value = Number(String(r.stdout || '').trim());
  return Number.isFinite(value) ? Math.round(value) : 0;
}

async function download(config, log, { target, title, maxBytes, maxDurationSec, timeoutMs, dir, maxHeight }) {
  ensureDir(dir);
  const template = path.join(dir, '%(id)s.%(ext)s');
  const format = [
    `bv*[height<=${maxHeight}][vcodec^=avc1]+ba[acodec^=mp4a]`,
    `b[height<=${maxHeight}][ext=mp4]`,
    `bv*[height<=${maxHeight}]+ba`,
    'b',
  ].join('/');
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--no-part',
    '--no-progress',
    '--merge-output-format',
    'mp4',
    '--print',
    'after_move:filepath',
    '--user-agent',
    UA,
    '--referer',
    REF,
    '-f',
    format,
    '-o',
    template,
    '--max-filesize',
    String(maxBytes),
    target,
  ];
  log?.info?.(`开始下载视频：${title || target}`);
  const r = await runYtdlp(config, args, { timeoutMs });
  if (r.code !== 0) {
    const tail = truncate(r.stderr.trim().split('\n').slice(-3).join(' '), 300);
    if (/max-filesize/i.test(r.stderr)) throw new Error(`视频超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限，换短一点的`);
    throw new Error(`视频下载失败：${tail || `yt-dlp 退出码 ${r.code}`}`);
  }
  const lines = r.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const file = [...lines].reverse().find((item) => VIDEO_EXT.has(path.extname(item).toLowerCase()) && fs.existsSync(item));
  if (!file) {
    if (/max-filesize|larger than/i.test(r.stderr)) throw new Error(`视频超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限，换短一点的`);
    throw new Error('下载没有产出视频文件（可能格式不可用或已被跳过）');
  }
  const stat = fs.statSync(file);
  if (stat.size > maxBytes) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
    throw new Error(`视频 ${Math.round(stat.size / 1024 / 1024)}MB 超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限，换短一点的`);
  }
  const duration = probeDuration(file);
  if (maxDurationSec && duration > maxDurationSec) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
    throw new Error(`视频 ${duration} 秒，超过 ${maxDurationSec} 秒上限`);
  }
  return { file, bytes: stat.size, duration };
}

async function fetchInfo(config, target, timeoutMs) {
  const r = await runYtdlp(config, ['--no-warnings', '-J', '--no-playlist', target, '--user-agent', UA, '--referer', REF], { timeoutMs });
  if (r.code !== 0) {
    throw new Error(`解析视频失败：${truncate(r.stderr.trim().split('\n').slice(-3).join(' '), 300)}`);
  }
  let info;
  try {
    info = JSON.parse(r.stdout);
  } catch {
    throw new Error('视频信息解析失败');
  }
  if (info?._type === 'playlist' && Array.isArray(info.entries) && info.entries[0]) info = info.entries[0];
  return info;
}

/** 失败时清掉这一条留下的分段/半成品文件。 */
function cleanupPartial(dir, id) {
  if (!id) return;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name === `${id}.mp4` || name.startsWith(`${id}.`) || name.startsWith(`${id}_`)) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * 解析并下载一个视频：支持关键词（B 站搜索）或直达链接（含 BV 号）。
 * 搜索会按匹配度依次尝试前几条候选，超时长/超体积的自动跳过。
 * @returns {Promise<{source:string,id:string,title:string,uploader:string,url:string,file:string,bytes:number,duration:number}>}
 */
export async function resolveVideo({ query = '', url = '' } = {}, config, log) {
  const s = videoSettings(config);
  const direct = normalizeTarget(url);
  const infoTimeout = Number(config.video?.searchTimeoutMs) || 60000;
  let candidates;
  if (direct) {
    candidates = [{ webpage_url: direct }];
  } else {
    const entries = await searchVideos(query, config);
    candidates = rankVideos(entries, query, s.maxDurationSec).slice(0, 4);
    if (!candidates.length) throw new Error(`没搜到「${query}」的合适视频（可能太长，上限 ${s.maxDurationSec} 秒）`);
  }
  let lastError = '';
  log?.info?.(`视频候选 ${candidates.length} 个：${candidates.map((item) => item.title || item.webpage_url || '').join(' | ').slice(0, 200)}`);
  for (const candidate of candidates) {
    let target = candidate.webpage_url || candidate.url || '';
    let info = candidate;
    try {
      if (!info.duration || !info.title) {
        log?.info?.(`补全视频信息：${target}`);
        info = await fetchInfo(config, target, infoTimeout);
        target = info?.webpage_url || target;
      }
      log?.info?.(`尝试视频：${info?.title || target}（${info?.duration || '?'} 秒）`);
      const duration = Math.round(Number(info?.duration) || 0);
      if (s.maxDurationSec && duration > s.maxDurationSec) throw new Error(`视频 ${duration} 秒，超过 ${s.maxDurationSec} 秒上限`);
      const result = await download(config, log, {
        target,
        title: info?.title,
        maxBytes: s.maxBytes,
        maxDurationSec: s.maxDurationSec,
        timeoutMs: s.timeoutMs,
        dir: s.dir,
        maxHeight: s.maxHeight,
      });
      return {
        source: /bilibili/i.test(`${target}`) ? 'bilibili' : 'ytdlp',
        id: String(info?.id || ''),
        title: String(info?.title || path.basename(result.file)),
        uploader: String(info?.uploader || info?.channel || ''),
        url: target,
        file: result.file,
        bytes: result.bytes,
        duration: result.duration || duration,
      };
    } catch (error) {
      lastError = error.message;
      cleanupPartial(s.dir, String(info?.id || candidate.id || ''));
      log?.warn?.(`视频候选失败「${candidate.title || target}」：${error.message}`);
    }
  }
  throw new Error(lastError || '视频下载失败');
}

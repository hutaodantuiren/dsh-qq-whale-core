/**
 * 把已安装的 DSH 插件 dsh-song-download 当成「点歌下载器」直接用。
 *
 * 插件本身是一个 DSH 插件（导出 apply(ctx)），它把 yt-dlp 的搜索/下载流程包成
 * song_search / song_download 两个工具。这里不复制那份实现，而是用一套最小的
 * ctx 垫片把插件跑起来，拿到 song_download 工具直接调用 —— 插件升级/换源时
 * 点歌流程跟着一起变。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ensureDir } from './util.js';
import { whichExecutable } from './ytdlp.js';

const cache = new Map();

// 插件这个版本会传 `--no-write-danmaku`，新版 yt-dlp 已删掉该选项，会直接报
// “no such option” 让整次下载失败。垫片里把已移除的选项过滤掉，其余参数原样透传。
const DROPPED_YTDLP_OPTIONS = new Set(['--no-write-danmaku']);

function collect(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  stream.on('data', (chunk) => {
    size += chunk.length;
    chunks.push(chunk);
    while (size > maxBytes && chunks.length > 1) size -= chunks.shift().length;
  });
  return () => ({ text: Buffer.concat(chunks).toString('utf8') });
}

/** DSH 的 subprocess 服务垫片：只实现插件用到的那几个方法。 */
function createSubprocessShim() {
  return {
    async resolveExecutable(name) {
      return whichExecutable(name) || name;
    },
    spawn({ argv, cwd, stdio, signal, env }) {
      const [command, ...rawArgs] = argv;
      const args = rawArgs.filter((arg) => !DROPPED_YTDLP_OPTIONS.has(arg));
      const child = spawn(command, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(env || {}) },
      });
      const maxOut = stdio?.stdout?.maxBytes || 4 * 1024 * 1024;
      const maxErr = stdio?.stderr?.maxBytes || 4 * 1024 * 1024;
      const readOut = collect(child.stdout, maxOut);
      const readErr = collect(child.stderr, maxErr);
      const done = new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener?.('abort', onAbort);
          resolve(value);
        };
        const onAbort = () => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
        child.on('error', (error) => finish({ exitCode: -1, error }));
        child.on('close', (code) => finish({ exitCode: code == null ? -1 : code }));
      });
      return {
        done,
        collected: {
          stdout: { readFrom: () => readOut() },
          stderr: { readFrom: () => readErr() },
        },
      };
    },
  };
}

function pluginFile(config) {
  const configured = config.music?.pluginPath;
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), '.dsh', 'plugins', 'dsh-song-download', 'lib', 'index.js');
}

/** 载入插件并取到 song_download 工具；同一个插件文件只跑一次 apply。 */
async function loadSongTool(config) {
  const file = pluginFile(config);
  if (!fs.existsSync(file)) {
    throw new Error(`找不到 dsh-song-download 插件：${file}（可在 config.music.pluginPath 指定）`);
  }
  const hit = cache.get(file);
  if (hit) return hit;
  const tools = [];
  const ctx = {
    get(name) {
      if (name === 'subprocess') return createSubprocessShim();
      if (name === 'sandboxPolicy') return { workspaceRoot: path.join(config.paths.media, 'music') };
      return undefined;
    },
    effect(fn) {
      return typeof fn === 'function' ? fn() : undefined;
    },
    tools: {
      register(tool) {
        tools.push(tool);
        return () => {};
      },
    },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
  };
  const mod = await import(pathToFileURL(file).href);
  mod.apply(ctx);
  const tool = tools.find((item) => item?.name === 'song_download');
  if (!tool) throw new Error('dsh-song-download 插件没有注册 song_download 工具');
  const entry = { file, tool };
  cache.set(file, entry);
  return entry;
}

function splitName(savedTo) {
  const base = path.basename(savedTo).replace(/\.[^.]+$/, '');
  const index = base.indexOf(' - ');
  if (index > 0) return { artist: base.slice(0, index).trim(), title: base.slice(index + 3).trim() || base };
  return { artist: '', title: base };
}

/**
 * 用 dsh-song-download 插件下载一首歌（B 站优先、YouTube 兜底、ffmpeg 转 MP3 320k）。
 * @returns {Promise<object>} 与 music.js 里 song 结构一致
 */
export async function downloadViaSongPlugin(query, config, log) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query 不能为空');
  const { tool } = await loadSongTool(config);
  const outDir = ensureDir(path.join(config.paths.media, 'music'));
  const controller = new AbortController();
  const timeoutMs = Number(config.music?.downloadTimeoutMs) || 180000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    log?.info?.(`点歌：调用 dsh-song-download 插件下载「${q}」`);
    const result = await tool.execute({ query: q, outDir, format: 'mp3', write_lyrics: false }, { signal: controller.signal });
    if (!result || result.ok === false) throw new Error(result?.error || '插件没有返回文件');
    const file = String(result.savedTo || '');
    if (!file || !fs.existsSync(file)) throw new Error(`插件说下载成功但文件不存在：${file || '(空)'}`);
    const stat = fs.statSync(file);
    const maxBytes = config.music?.maxBytes || 15 * 1024 * 1024;
    if (stat.size > maxBytes) throw new Error(`文件太大（${Math.round(stat.size / 1024 / 1024)}MB），超过 music.maxBytes`);
    const parsed = splitName(file);
    const title = String(result.title || '').replace(/\.[^.]+$/, '') || parsed.title;
    log?.info?.(`点歌下载完成（插件）：${title}（${Math.round(stat.size / 1024)}KB）`);
    return {
      source: 'plugin',
      id: '',
      mid: '',
      title: parsed.title || title,
      artist: parsed.artist,
      album: '',
      duration: 0,
      url: '',
      file,
      bytes: stat.size,
      contentType: 'audio/mpeg',
      downloadedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

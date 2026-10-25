import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureDir, truncate } from './util.js';
import { httpGet } from './web.js';

function run(command, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`命令超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 200000) stdout = stdout.slice(-200000);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`命令退出码 ${code}：${truncate(stderr.trim(), 300)}`));
    });
  });
}

async function fetchVoiceFile({ onebot, segment, config }) {
  const data = segment.data || {};
  let url = data.url || '';
  let buffer;
  let contentType = '';
  if (!url && data.file && /^https?:/i.test(data.file)) url = data.file;
  if (url) {
    const res = await httpGet(url, { timeoutMs: 30000, maxBytes: config.voice?.maxBytes || 20971520 });
    buffer = res.buffer;
    contentType = res.contentType;
  } else if (data.file) {
    const record = await onebot.getRecord(data.file, 'wav');
    if (typeof record === 'string' && fs.existsSync(record)) {
      buffer = fs.readFileSync(record);
      contentType = 'audio/wav';
    } else if (record?.base64) {
      buffer = Buffer.from(String(record.base64).replace(/^base64:\/\//, ''), 'base64');
      contentType = 'audio/wav';
    } else if (record?.url) {
      const res = await httpGet(record.url, { timeoutMs: 30000, maxBytes: config.voice?.maxBytes || 20971520 });
      buffer = res.buffer;
      contentType = res.contentType;
    } else if (record?.file && /^https?:/i.test(record.file)) {
      const res = await httpGet(record.file, { timeoutMs: 30000, maxBytes: config.voice?.maxBytes || 20971520 });
      buffer = res.buffer;
      contentType = res.contentType;
    } else if (record?.file && fs.existsSync(record.file)) {
      buffer = fs.readFileSync(record.file);
      contentType = 'audio/wav';
    }
  }
  if (!buffer?.length) throw new Error('无法取得语音文件（SnowLuma 可能没有提供 URL）');
  const mime = String(contentType).split(';')[0] || 'audio/wav';
  const ext = mime.includes('silk') ? 'silk' : mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : mime.includes('amr') ? 'amr' : mime.includes('ogg') ? 'ogg' : 'wav';
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
  const dir = path.join(config.paths.media, 'voice');
  ensureDir(dir);
  const file = path.join(dir, `${hash}.${ext}`);
  fs.writeFileSync(file, buffer);
  return { file, mime, bytes: buffer.length };
}

async function convertToWav(input, config, log) {
  const ffmpeg = config.voice?.ffmpegPath || 'ffmpeg';
  const output = input.replace(/\.[^.]+$/, '') + '.16k.wav';
  try {
    await run(ffmpeg, ['-y', '-i', input, '-ar', '16000', '-ac', '1', '-f', 'wav', output], { timeoutMs: 60000 });
    return output;
  } catch (error) {
    log?.warn?.(`ffmpeg 转码失败，尝试直接转写原文件：${error.message}`);
    return input;
  }
}

async function transcribeByCommand(wav, config) {
  const command = config.voice?.command;
  if (!command) return null;
  const args = (config.voice.args || []).map((arg) => String(arg).replaceAll('{input}', wav));
  if (!args.length) args.push(wav);
  const { stdout } = await run(command, args, { timeoutMs: config.voice.timeoutMs || 60000 });
  const text = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  return text;
}

async function transcribeByWindows(wav, config) {
  if (process.platform !== 'win32') return null;
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'win-stt.ps1');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', wav, '-Language', config.voice.language || 'zh-CN'], {
    timeoutMs: config.voice.timeoutMs || 60000,
  });
  return String(stdout || '').trim();
}

async function transcribeByApi(wav, config) {
  const apiUrl = config.voice?.apiUrl;
  if (!apiUrl) return null;
  const base = apiUrl.endsWith('/audio/transcriptions') ? apiUrl : `${apiUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`;
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), path.basename(wav));
  form.append('model', config.voice.model || 'whisper-1');
  const headers = {};
  if (config.voice.apiKey) headers.Authorization = `Bearer ${config.voice.apiKey}`;
  const response = await fetch(base, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(config.voice.timeoutMs || 60000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `STT HTTP ${response.status}`);
  return String(data.text || '').trim();
}

export async function transcribeMessage({ onebot, message, config, log }) {
  if (!config.voice?.enabled) throw new Error('语音功能未启用');
  const segment = (message.segments || []).find((item) => item.type === 'record');
  if (!segment) throw new Error('这条消息没有语音');
  const fileInfo = await fetchVoiceFile({ onebot, segment, config });
  const wav = await convertToWav(fileInfo.file, config, log);
  const provider = config.voice.provider || 'auto';
  let text = null;
  let used = '';
  if (provider === 'command' || (provider === 'auto' && config.voice.command)) {
    text = await transcribeByCommand(wav, config);
    used = 'command';
  } else if (provider === 'api' || (provider === 'auto' && config.voice.apiUrl)) {
    text = await transcribeByApi(wav, config);
    used = 'api';
  } else if ((provider === 'windows' || provider === 'auto') && process.platform === 'win32') {
    text = await transcribeByWindows(wav, config);
    used = 'windows';
  }
  if (text === null) {
    return {
      ok: false,
      text: '',
      file: fileInfo.file,
      note: '未配置语音转写。可以填 voice.command（本地 whisper）、voice.apiUrl（OpenAI 兼容）或 voice.provider="windows"（Windows 内置识别）。',
    };
  }
  if (!text) throw new Error('转写结果为空');
  return { ok: true, text: truncate(text, 2000), file: fileInfo.file, wav, provider: used };
}

/**
 * 极简 yt-dlp 调用器：找 python、拼参数、收 stdout/stderr。
 * 点歌之外的地方（比如发 B 站视频）都用这一套，避免每个模块各写一份。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** PATH 里找可执行文件，返回绝对路径（找不到就返回空串）。 */
export function whichExecutable(name) {
  if (!name) return '';
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    // WindowsApps 里的 python.exe 是 0 字节的应用商店别名，spawn 它会挂住，跳过。
    if (/[\\/]windowsapps[\\/]?$/i.test(dir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && stat.size > 1024) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return '';
}

export function ytdlpInvocation(config) {
  const command = config?.ytdlp?.command || 'python';
  const prefix = Array.isArray(config?.ytdlp?.args) ? config.ytdlp.args.map(String) : ['-m', 'yt_dlp'];
  return { command, prefix };
}

/**
 * 跑一次 yt-dlp。
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function runYtdlp(config, args, { timeoutMs = 180000, signal, maxBytes = 8 * 1024 * 1024 } = {}) {
  const { command, prefix } = ytdlpInvocation(config);
  const executable = whichExecutable(command) || command;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...prefix, ...args.map(String)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(new Error(`yt-dlp 超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(new Error('已取消'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > maxBytes) stdout = stdout.slice(-maxBytes);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 200000) stderr = stderr.slice(-200000);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (settled) return;
      finish();
      resolve({ code: code == null ? -1 : code, stdout, stderr });
    });
  });
}

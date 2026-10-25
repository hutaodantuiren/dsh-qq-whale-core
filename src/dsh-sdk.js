import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import readline from 'node:readline';
import { sleep } from './util.js';

function quoteWin(arg) {
  return `"${String(arg).replace(/"/g, '""')}"`;
}

function spawnDsh(command, args, options) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call', command, ...args], options);
  }
  return spawn(command, args, options);
}

/**
 * DeepSeek Harness SDK 运行时客户端。
 * 通过 stdio 上的换行分隔 JSON-RPC 驱动 `dsh --profile sdk`，
 * 每个 QQ 会话对应一个持久化 DSH session。
 */
export class DshRuntime extends EventEmitter {
  constructor({ command, profile = 'sdk', patch = '', workspace, provider, model, reasoningEffort, maxTokens, startupTimeoutMs = 120000, turnTimeoutMs = 900000, log }) {
    super();
    this.command = command;
    this.profile = profile;
    this.patch = patch;
    this.workspace = workspace;
    this.provider = provider;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.maxTokens = maxTokens;
    this.startupTimeoutMs = startupTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.log = log;
    this.child = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.closed = false;
    this.sessions = new Map();
    this.stderrBuffer = '';
    this.exitInfo = null;
  }

  buildArgs() {
    const args = ['--profile', this.profile];
    if (this.patch && fs.existsSync(this.patch)) args.push('--patch', this.patch);
    return args;
  }

  async start() {
    fs.mkdirSync(this.workspace, { recursive: true });
    const args = this.buildArgs();
    this.log.info(`启动 DSH SDK 运行时：${this.command} ${args.join(' ')}`);
    this.child = spawnDsh(this.command, args, {
      cwd: this.workspace,
      env: {
        ...process.env,
        DSH_LOG_LEVEL: process.env.DSH_LOG_LEVEL || 'error',
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      this.initialized = false;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`DSH SDK 进程已退出（code=${code} signal=${signal}）`));
      }
      this.pending.clear();
      for (const session of this.sessions.values()) {
        if (session.reject) session.reject(new Error('DSH SDK 进程已退出'));
      }
      this.sessions.clear();
      this.emit('exit', this.exitInfo);
    });

    this.child.on('error', (error) => {
      this.log.error(`DSH SDK 进程错误：${error.message}`);
    });

    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => this.handleLine(line));

    this.child.stderr.on('data', (chunk) => {
      this.stderrBuffer += chunk.toString('utf8');
      if (this.stderrBuffer.length > 8000) this.stderrBuffer = this.stderrBuffer.slice(-8000);
      const lines = this.stderrBuffer.split('\n');
      this.stderrBuffer = lines.pop() || '';
      for (const line of lines) {
        const text = line.trim();
        if (text) this.log.warn(`[dsh] ${text.slice(0, 500)}`);
      }
    });

    await sleep(300);
    await this.initialize();
    return this;
  }

  async initialize() {
    const result = await this.request(
      'initialize',
      {
        cwd: this.workspace,
        provider: this.provider,
        model: this.model,
        ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
        ...(this.maxTokens ? { maxTokens: this.maxTokens } : {}),
      },
      { timeoutMs: this.startupTimeoutMs },
    );
    this.initialized = true;
    this.log.info(`DSH SDK 已就绪：${result?.serverInfo?.name || 'unknown'} ${result?.serverInfo?.version || ''}`);
    return result;
  }

  handleLine(line) {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.log.debug(`[dsh stdout] ${text.slice(0, 300)}`);
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        const error = new Error(msg.error.message || 'DSH RPC error');
        error.code = msg.error.code;
        error.data = msg.error.data;
        pending.reject(error);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.method) this.handleNotification(msg.method, msg.params || {});
  }

  handleNotification(method, params) {
    if (method === 'session.event') {
      const { sessionId, event } = params;
      this.trackEvent(sessionId, event);
      this.emit('session-event', { sessionId, event });
      return;
    }
    if (method === 'session.status') {
      this.emit('status', params);
      const rec = this.sessions.get(params.sessionId);
      if (rec && params.status === 'idle' && rec.pendingTurn) {
        rec.idleAt = Date.now();
        clearTimeout(rec.idleTimer);
        rec.idleTimer = setTimeout(() => {
          if (rec.pendingTurn) this.finishTurn(params.sessionId, { reason: 'idle' });
        }, 1500);
      }
      return;
    }
    this.emit('notification', { method, params });
  }

  trackEvent(sessionId, event) {
    if (!event || !event.type) return;
    let rec = this.sessions.get(sessionId);
    if (!rec) {
      rec = { pendingTurn: null, lastText: '', reasoning: '', usage: null, turnStartedAt: 0 };
      this.sessions.set(sessionId, rec);
    }
    if (event.type === 'turn/start') {
      rec.turnStartedAt = Date.now();
      rec.lastText = '';
      rec.reasoning = '';
      rec.usage = null;
      return;
    }
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content;
      if (Array.isArray(content)) {
        const textParts = content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text);
        const text = textParts.join('').trim();
        if (text) rec.lastText = text;
        const reasoningParts = content.filter((block) => block?.type === 'reasoning' && typeof block.text === 'string').map((block) => block.text);
        if (reasoningParts.length) {
          rec.reasoning = `${rec.reasoning || ''}\n${reasoningParts.join('\n')}`.trim().slice(-20000);
        }
      }
      const usage = event.data?.usage || event.data?.message?.usage;
      if (usage) rec.usage = usage;
      return;
    }
    if (event.type === 'turn/end') {
      this.finishTurn(sessionId, { reason: event.data?.reason?.kind || 'completed', event });
    }
  }

  finishTurn(sessionId, info) {
    const rec = this.sessions.get(sessionId);
    if (!rec || !rec.pendingTurn) return;
    const pending = rec.pendingTurn;
    rec.pendingTurn = null;
    clearTimeout(pending.timer);
    clearTimeout(rec.idleTimer);
    const result = {
      text: pending.textOverride ?? rec.lastText ?? '',
      reasoning: rec.reasoning || '',
      usage: rec.usage || null,
      reason: info.reason || 'completed',
      startedAt: rec.turnStartedAt,
      durationMs: Date.now() - rec.turnStartedAt,
    };
    pending.resolve(result);
    this.emit('turn', { sessionId, ...result });
  }

  async request(method, params = {}, { timeoutMs = 60000 } = {}) {
    if (this.closed) throw new Error('DSH SDK 已关闭');
    if (!this.child || this.child.exitCode !== null) throw new Error('DSH SDK 进程未运行');
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`DSH RPC 超时：${method}（${Math.round(timeoutMs / 1000)}s）`);
        error.code = 'TIMEOUT';
        reject(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.child.stdin.write(`${frame}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async resume(sessionId) {
    try {
      await this.request('session/resume', { sessionId }, { timeoutMs: 60000 });
      return true;
    } catch (error) {
      if (error.code === 'TIMEOUT') throw error;
      return false;
    }
  }

  async prompt(sessionId, text, { timeoutMs = this.turnTimeoutMs, images = [] } = {}) {
    let rec = this.sessions.get(sessionId);
    if (!rec) {
      rec = { pendingTurn: null, lastText: '', reasoning: '', usage: null, turnStartedAt: 0 };
      this.sessions.set(sessionId, rec);
    }
    if (rec.pendingTurn) throw new Error('该会话上一轮尚未结束');
    const turnPromise = new Promise((resolve, reject) => {
      rec.pendingTurn = { resolve, reject, timer: null, textOverride: undefined };
    });
    const timer = setTimeout(() => {
      if (!rec.pendingTurn) return;
      const pending = rec.pendingTurn;
      rec.pendingTurn = null;
      pending.reject(new Error(`会话本轮超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    timer.unref?.();
    rec.pendingTurn.timer = timer;

    try {
      const contentBlocks = [{ type: 'text', text }];
      for (const image of images) {
        if (image?.data && image?.mimeType) contentBlocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
      }
      await this.request('session/prompt', { sessionId, contentBlocks }, { timeoutMs: 60000 });
    } catch (error) {
      clearTimeout(timer);
      rec.pendingTurn = null;
      throw error;
    }
    return turnPromise;
  }

  async shutdown() {
    this.closed = true;
    try {
      await this.request('shutdown', {}, { timeoutMs: 5000 });
    } catch {
      /* ignore */
    }
    await sleep(300);
    if (this.child && this.child.exitCode === null) {
      try {
        this.child.stdin.end();
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (this.child && this.child.exitCode === null) {
          try {
            this.child.kill();
          } catch {
            /* ignore */
          }
        }
      }, 2500).unref?.();
    }
  }
}

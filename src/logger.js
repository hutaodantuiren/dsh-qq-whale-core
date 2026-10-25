import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './util.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor({ file = '', level = 'info', ringSize = 400 } = {}) {
    this.file = file;
    this.level = LEVELS[level] ?? LEVELS.info;
    this.ring = [];
    this.ringSize = ringSize;
    this.listeners = new Set();
    if (file) {
      ensureDir(path.dirname(file));
      try {
        if (fs.existsSync(file) && fs.statSync(file).size > 8 * 1024 * 1024) {
          fs.renameSync(file, `${file}.1`);
        }
      } catch {
        /* ignore */
      }
    }
  }

  debug(...args) {
    this.write('debug', 'app', args);
  }

  info(...args) {
    this.write('info', 'app', args);
  }

  warn(...args) {
    this.write('warn', 'app', args);
  }

  error(...args) {
    this.write('error', 'app', args);
  }

  child(scope) {
    const parent = this;
    return {
      debug: (...args) => parent.write('debug', scope, args),
      info: (...args) => parent.write('info', scope, args),
      warn: (...args) => parent.write('warn', scope, args),
      error: (...args) => parent.write('error', scope, args),
      child: (nested) => parent.child(`${scope}:${nested}`),
      tail: (limit) => parent.tail(limit),
      subscribe: (listener) => parent.subscribe(listener),
    };
  }

  write(level, scope, args) {
    if ((LEVELS[level] ?? 20) < this.level) return;
    const time = new Date();
    const stamp = time.toTimeString().slice(0, 8);
    const text = args
      .map((arg) => {
        if (arg instanceof Error) return arg.stack || arg.message;
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ');
    const line = `${stamp} [${scope}] ${text}`;
    const entry = { time: time.getTime(), level, scope, text };
    this.ring.push(entry);
    if (this.ring.length > this.ringSize) this.ring.shift();
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    if (this.file) {
      try {
        fs.appendFileSync(this.file, `${line}\n`);
      } catch {
        /* ignore */
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        /* ignore */
      }
    }
  }

  tail(limit = 120) {
    return this.ring.slice(-limit);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

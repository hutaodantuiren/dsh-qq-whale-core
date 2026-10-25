#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, PROJECT_ROOT } from './config.js';
import { Logger } from './logger.js';
import { Bridge } from './bridge.js';
import { sleep } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = loadConfig();
  const log = new Logger({
    file: path.join(config.paths.logs, 'bridge.log'),
    level: process.env.QQ_BRIDGE_LOG_LEVEL || 'info',
  });
  log.info('🐳 DeepSeek 小鲸鱼 QQ 桥接启动中…');
  log.info(`项目目录：${PROJECT_ROOT}`);
  log.info(`配置：${config.paths.config}`);
  log.info(`工作区：${config.paths.workspace}`);

  if (!fs.existsSync(config.paths.patch)) {
    log.warn(`DSH patch 不存在：${config.paths.patch}`);
    log.warn('请先运行：node scripts/setup.mjs');
  }
  if (!fs.existsSync(config.paths.workspace)) {
    log.warn(`工作区不存在：${config.paths.workspace}`);
  }

  const bridge = new Bridge(config, log);
  globalThis.__qqBridge = bridge;

  const shutdown = async (signal) => {
    log.info(`收到 ${signal}，正在停止…`);
    try {
      await bridge.stop();
    } catch (error) {
      log.error(`停止失败：${error.message}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (error) => log.error(`未处理的 Promise 拒绝：${error?.stack || error}`));
  process.on('uncaughtException', (error) => log.error(`未捕获异常：${error?.stack || error}`));

  await bridge.start();
  const deadline = Date.now() + 20000;
  while (!bridge.dshReady && Date.now() < deadline) await sleep(300);

  const status = bridge.toolStatus();
  log.info('────────────────────────────────────────────');
  log.info(`QQ：${status.snowluma.nickname || '未登录'}（${status.snowluma.selfId || '?'}）`);
  log.info(`DSH：${status.dsh.ready ? '已就绪' : '启动中/失败'} · ${status.dsh.model}`);
  log.info(`余额：${status.balance?.text || '未知'}`);
  log.info(`控制台：${bridge.controlUrl}/?token=${config.bridge.token}`);
  log.info('────────────────────────────────────────────');
}

main().catch((error) => {
  console.error(`启动失败：${error.stack || error.message}`);
  process.exit(1);
});

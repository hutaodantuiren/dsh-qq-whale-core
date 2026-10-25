#!/usr/bin/env node
/**
 * 头像猎手：搜索并下载适合当小鲸鱼头像的图片。
 * 用法：
 *   node scripts/avatar-hunt.mjs "DeepSeek 小鲸鱼 蓝色 头像"
 *   node scripts/avatar-hunt.mjs "鲸鱼娘 蓝发 二次元" --count 6
 *   node scripts/avatar-hunt.mjs "" --choose 1        # 选第 1 张设为头像（需要 SnowLuma 支持）
 */
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { findAvatars, setAvatar } from '../src/avatar.js';
import { OneBot } from '../src/onebot.js';

const args = process.argv.slice(2);
const query = args.find((arg) => !arg.startsWith('--')) || 'DeepSeek 小鲸鱼 蓝色 头发 鲸鱼尾巴 头像 二次元';
const countIndex = args.indexOf('--count');
const count = countIndex >= 0 ? Number(args[countIndex + 1]) || 4 : 4;
const chooseIndex = args.indexOf('--choose');
const choose = chooseIndex >= 0 ? Number(args[chooseIndex + 1]) : 0;

const config = loadConfig();
const log = new Logger({ file: path.join(config.paths.logs, 'avatar.log') }).child('avatar');

const result = await findAvatars(query, config, log, count);
console.log(`搜索：${result.query}`);
for (const [index, candidate] of result.candidates.entries()) {
  console.log(`${index + 1}. ${candidate.path}  (${Math.round(candidate.bytes / 1024)} KB)  ${candidate.url}`);
}
if (result.errors.length) console.log(`\n部分失败：${result.errors.join('；')}`);

if (choose > 0 && choose <= result.candidates.length) {
  const onebot = new OneBot(config.snowluma, log);
  const picked = result.candidates[choose - 1];
  const res = await setAvatar(picked.path, onebot, log);
  console.log(`\n${res.ok ? '✓' : '⚠'} ${res.note}`);
}

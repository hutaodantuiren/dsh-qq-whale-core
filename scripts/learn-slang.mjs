#!/usr/bin/env node
/**
 * 黑话学习：把群聊里反复出现、尚未收录的词拿到网上查含义，写入词典。
 * 用法：node scripts/learn-slang.mjs [--limit 8] [--dry]
 */
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { SlangStore } from '../src/slang.js';
import { searchWeb } from '../src/web.js';
import { sleep } from '../src/util.js';

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) || 8 : 8;
const dry = args.includes('--dry');

const config = loadConfig();
const log = new Logger({ file: path.join(config.paths.logs, 'slang-learn.log') }).child('slang-learn');
const slang = new SlangStore(config, log);

const candidates = slang.hints(limit);
if (!candidates.length) {
  console.log('没有达到阈值的候选词。多在群里聊几句再来。');
  process.exit(0);
}

console.log(`候选 ${candidates.length} 个：${candidates.map((item) => `${item.term}×${item.count}`).join('、')}\n`);

let learned = 0;
for (const item of candidates) {
  const query = `${item.term} 梗 什么意思 出处`;
  try {
    const result = await searchWeb(query, config);
    const snippets = result.results.slice(0, 3).map((r) => r.snippet || r.title).filter(Boolean);
    const meaning = snippets.join(' / ').slice(0, 240);
    if (!meaning) {
      console.log(`- ${item.term}：没搜到摘要，跳过`);
      continue;
    }
    console.log(`- ${item.term}：${meaning}`);
    if (!dry) {
      slang.submit({ term: item.term, meaning, usage: '', tags: ['web-learned'], source: 'web' });
      learned += 1;
    }
    await sleep(1200);
  } catch (error) {
    console.log(`- ${item.term}：搜索失败（${error.message}）`);
  }
}

console.log(`\n${dry ? '（dry-run，未写入）' : `已写入 ${learned} 条到 state/slang.json`}。`);

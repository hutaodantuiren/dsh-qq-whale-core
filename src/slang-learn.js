import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic, sleep } from './util.js';
import { searchWeb } from './web.js';

const stateFile = (config) => path.join(config.paths.state, 'slang-learn.json');

export function lastLearn(config) {
  return readJson(stateFile(config), null) || { lastRun: 0, learned: 0 };
}

/**
 * 把高频但未收录的候选词拿去网上查含义并写入词典。
 * 由桥接定时调用，也可以被 scripts/learn-slang.mjs 手动调用。
 */
export async function learnSlang({ config, log, slang, limit = 4, dry = false }) {
  const candidates = slang.hints(limit);
  if (!candidates.length) {
    if (!dry) writeJsonAtomic(stateFile(config), { lastRun: Date.now(), learned: 0, results: [] });
    return { learned: 0, skipped: 0, results: [] };
  }
  const results = [];
  let learned = 0;
  for (const item of candidates) {
    try {
      const found = await searchWeb(`${item.term} 梗 什么意思 出处`, config);
      const snippets = found.results.slice(0, 3).map((r) => r.snippet || r.title).filter(Boolean);
      const meaning = snippets.join(' / ').slice(0, 240);
      if (!meaning) {
        results.push({ term: item.term, ok: false, reason: 'no-snippet' });
        continue;
      }
      if (!dry) {
        slang.submit({ term: item.term, meaning, usage: '', tags: ['web-learned'], source: 'web-auto' });
        learned += 1;
      }
      results.push({ term: item.term, ok: true, meaning });
      await sleep(1200);
    } catch (error) {
      results.push({ term: item.term, ok: false, reason: error.message });
      log?.warn?.(`黑话学习失败 ${item.term}：${error.message}`);
    }
  }
  if (!dry) writeJsonAtomic(stateFile(config), { lastRun: Date.now(), learned, results: results.slice(-20) });
  log?.info?.(`黑话自动学习完成：${learned}/${candidates.length}`);
  return { learned, skipped: candidates.length - learned, results };
}

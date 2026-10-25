import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripMarkdown, splitOutgoing, truncate, clamp } from '../src/util.js';
import { buildWakeConfig, describeWake, buildTurnPrompt } from '../src/prompt.js';
import { analyzeHostility, shouldSelfRecall } from '../src/admin.js';
import { parseBingResults, parseDuckResults, htmlToText, isPrivateHost } from '../src/web.js';
import { MemoryStore } from '../src/memory.js';
import { SlangStore } from '../src/slang.js';
import { formatBalance } from '../src/balance.js';

test('stripMarkdown 去掉 QQ 不支持的格式', () => {
  const input = '# 标题\n**粗体** 和 `代码`，[链接](https://example.com)\n- 列表';
  const output = stripMarkdown(input);
  assert.ok(!output.includes('**'));
  assert.ok(!output.includes('#'));
  assert.ok(output.includes('链接 (https://example.com)'));
});

test('splitOutgoing 优先按行分条且不拆完整句', () => {
  assert.deepEqual(splitOutgoing('草\n勇士'), ['草', '勇士']);
  const long = '今天真的发生了一件特别离谱的事情，我到现在都没缓过来。你猜怎么着？';
  const parts = splitOutgoing(long, 30, 5);
  assert.ok(parts.length >= 2);
  for (const part of parts) assert.ok(part.length <= 30);
});

test('truncate/clamp 边界', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(clamp(10, 0, 5), 5);
  assert.equal(clamp(-1, 0, 5), 0);
});

test('buildWakeConfig 合并并限制参数', () => {
  const base = buildWakeConfig({ mode: 'auto', probability: 0.2, triggers: { atMention: true } });
  assert.equal(base.mode, 'auto');
  assert.equal(base.probability, 0.2);
  const next = buildWakeConfig(base, { mode: 'diving', probability: 2, sleepMinutes: -5, triggers: { speakerIds: ['123', 'abc'] } });
  assert.equal(next.mode, 'diving');
  assert.equal(next.probability, 1);
  assert.equal(next.sleepUntil, 0);
  assert.deepEqual(next.triggers.speakerIds, ['123']);
  assert.match(describeWake(next), /潜水/);
});

test('buildTurnPrompt 包含令牌、余额、消息与权限提示', () => {
  const chat = {
    kind: 'group',
    targetId: 123456,
    name: '测试群',
    token: 'tok-123',
    selfRole: { role: 'admin', canManage: true },
  };
  const messages = [
    {
      seq: 3,
      time: Date.now(),
      userId: 20001,
      sender: { nickname: '群友A', role: 'member' },
      text: '小鲸鱼在吗',
      atSelf: true,
      images: [],
      replyId: '',
    },
  ];
  const prompt = buildTurnPrompt({
    chat,
    messages,
    history: messages,
    self: { userId: 10001, nickname: '小鲸鱼' },
    balance: { balance: 9.18, todayUsage: 1.2 },
    wake: { reasonText: '有人 @ 了你', config: chat.wake || buildWakeConfig({}) },
    memoryText: '',
    slangHints: [{ term: '难绷', count: 3 }],
    adminHint: '你有管理权限',
    model: 'deepseek-flash',
  });
  assert.match(prompt, /tok-123/);
  assert.match(prompt, /¥9\.18/);
  assert.match(prompt, /小鲸鱼在吗/);
  assert.match(prompt, /管理员/);
  assert.match(prompt, /mcp__qq__send_message/);
});

test('hostility 检测与自我撤回', () => {
  assert.equal(analyzeHostility('小鲸鱼你就是个大肥鱼').hostile, true);
  assert.equal(analyzeHostility('今天天气不错').hostile, false);
  const config = { admin: { autoSelfRecall: { enabled: true, maxChars: 20, phrases: ['首先'] } } };
  assert.equal(shouldSelfRecall('首先，我觉得这个问题可以从三个方面来看', config).recall, true);
  assert.equal(shouldSelfRecall('草', config).recall, false);
});

test('搜索结果解析', () => {
  const html = '<li class="b_algo"><h2><a href="https://a.com">标题 A</a></h2><p>摘要 A</p></li>';
  const bing = parseBingResults(html);
  assert.equal(bing.length, 1);
  assert.equal(bing[0].url, 'https://a.com');
  const duck = parseDuckResults('<a class="result__a" href="https://b.com">标题 B</a><a class="result__snippet">摘要 B</a>');
  assert.equal(duck[0].url, 'https://b.com');
  assert.ok(htmlToText('<p>你好</p><script>x</script>').includes('你好'));
});

test('SSRF 主机判断', () => {
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost('192.168.1.2'), true);
  assert.equal(isPrivateHost('example.com'), false);
});

test('MemoryStore 增删查', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mem-'));
  const config = { paths: { memory: dir } };
  const store = new MemoryStore(config, null);
  store.append('group:1', { kind: 'topic', text: '在聊原神' });
  store.append('group:1', { kind: 'impression', about: '群友A', text: '喜欢猫' });
  assert.match(store.render('group:1'), /原神/);
  assert.match(store.render('group:1'), /喜欢猫/);
  assert.equal(store.remove('group:1', { kind: 'topic', text: '原神' }), 1);
  store.clear('group:1');
  assert.equal(store.render('group:1'), '');
});

test('SlangStore 记录候选并收录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-slang-'));
  const config = { paths: { state: dir }, slang: { enabled: true, minCount: 2, maxEntries: 100 } };
  const store = new SlangStore(config, null);
  store.observe({ text: '难绷', segments: [] });
  store.observe({ text: '难绷', segments: [] });
  assert.equal(store.hints(5)[0].term, '难绷');
  const entry = store.submit({ term: '难绷', meaning: '很难绷得住，想笑/无语' });
  assert.equal(entry.term, '难绷');
  assert.equal(store.query('难绷').entry.meaning.includes('无语'), true);
});

test('余额格式化', () => {
  assert.match(formatBalance({ balance: 9.18, todayUsage: 1.2, stale: false }), /¥9\.18/);
  assert.match(formatBalance(null), /未知/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelationsStore } from '../src/relations.js';
import { DiaryStore } from '../src/diary.js';
import { ArchiveStore } from '../src/archive.js';
import { buildTurnPrompt } from '../src/prompt.js';

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-feat-'));
  const config = {
    paths: { root: dir, state: path.join(dir, 'state'), workspace: path.join(dir, 'workspace'), media: path.join(dir, 'media'), memory: path.join(dir, 'memory') },
    relations: { enabled: true, maxUsers: 50 },
    diary: { enabled: true, maxMessages: 100 },
    archive: { enabled: true, images: true, files: true, maxPerDay: 20, dir: 'state/archive' },
    forward: { maxChars: 500, maxDepth: 2 },
    voice: { enabled: true, autoTranscribe: false },
  };
  for (const key of ['state', 'workspace', 'media', 'memory']) fs.mkdirSync(config.paths[key], { recursive: true });
  return config;
}

test('RelationsStore 记录好感、雷点与标签', () => {
  const config = tempConfig();
  const store = new RelationsStore(config, null);
  const user = store.observe('group:1', { userId: 2, sender: { nickname: '小明' }, text: '小鲸鱼好可爱', atSelf: true });
  const before = user.affinity;
  assert.ok(before > 0);
  store.observe('group:1', { userId: 2, sender: { nickname: '小明' }, text: '大肥鱼真垃圾' });
  const after = store.get('group:1', 2);
  assert.ok(after.affinity < before);
  assert.ok(after.insults >= 1);
  assert.match(store.render('group:1'), /小明/);
  store.adjust('group:1', 2, { delta: 2, note: '后来道歉了' });
  assert.equal(store.get('group:1', 2).notes.length >= 1, true);
});

test('DiaryStore 生成并保存日记', () => {
  const config = tempConfig();
  const store = new DiaryStore(config, null);
  const chat = { key: 'group:1', kind: 'group', targetId: 1, name: '测试群' };
  const doc = store.generate(chat, [
    { userId: 2, sender: { nickname: '小明' }, text: '今天去喝酒了', images: [], self: false, time: Date.now() },
    { userId: 3, sender: { nickname: '小红' }, text: '华莱士吃一次拉一次', images: [], self: false, time: Date.now() },
  ]);
  assert.match(doc.markdown, /小鲸鱼/);
  const file = store.save(doc.date, chat, doc);
  assert.ok(fs.existsSync(file));
  assert.ok(store.recent('group:1'));
  assert.equal(store.listRecent(3).length, 1);
});

test('ArchiveStore 统计与列表', () => {
  const config = tempConfig();
  const store = new ArchiveStore(config, null);
  store.entries.push(
    { ts: Date.now(), day: '2026-10-23', chat: 'group:1', kind: 'image', messageId: 'm1', bytes: 1000, nickname: '小明' },
    { ts: Date.now(), day: '2026-10-23', chat: 'group:1', kind: 'file', messageId: 'm2', bytes: 2000, nickname: '小红' },
  );
  const stats = store.stats('group:1');
  assert.equal(stats.total, 2);
  assert.equal(stats.bytes, 3000);
  assert.equal(store.list('group:1', { date: '2026-10-23' }).length, 2);
});

test('buildTurnPrompt 渲染转发/语音/关系/日记', () => {
  const chat = { kind: 'group', targetId: 1, token: 't', selfRole: { role: 'member' } };
  const prompt = buildTurnPrompt({
    chat,
    messages: [{
      seq: 1, time: Date.now(), userId: 2, sender: { nickname: '小明' }, text: '看这个', atSelf: false,
      images: [], forwards: [{ id: 'f1' }], voices: [{}], forwardText: '被转发的人：你好', voiceText: '语音内容',
    }],
    history: [],
    self: { userId: 9, nickname: '小鲸鱼' },
    balance: null,
    wake: { reasonText: '新消息', config: { mode: 'auto' } },
    relationsText: '聊得来：小明(3)',
    diaryText: '昨天聊了原神',
  });
  assert.match(prompt, /转发×1/);
  assert.match(prompt, /语音转写：语音内容/);
  assert.match(prompt, /聊得来：小明/);
  assert.match(prompt, /昨天聊了原神/);
});

test('Bridge.runDiary 生成会话日记文件', async () => {
  const { Bridge } = await import('../src/bridge.js');
  const config = tempConfig();
  const diary = new DiaryStore(config, null);
  const chat = { key: 'group:1', kind: 'group', targetId: 1, name: '测试群', messages: [
    { self: false, time: Date.now(), userId: 2, sender: { nickname: '小明' }, text: '今天好累', images: [] },
  ] };
  const fake = {
    chats: new Map([[chat.key, chat]]),
    config,
    diary,
    relations: { render: () => '' },
    memory: { render: () => '' },
    onebot: { sendMessage: async () => ({}) },
    log: { info: () => {} },
  };
  const result = await Bridge.prototype.runDiary.call(fake, '2026-10-23');
  assert.equal(result.chats, 1);
  assert.ok(fs.existsSync(path.join(config.paths.workspace, 'diary', '2026-10-23', 'group_1.md')));
});

test('Bridge.checkProactive 冷场时安排主动话题', async () => {
  const { Bridge } = await import('../src/bridge.js');
  const config = tempConfig();
  config.proactive = { enabled: true, idleThresholdMs: 0, checkIntervalMs: 60000, probability: 1, minGapMs: 0 };
  const chat = {
    kind: 'group', running: false, timer: null, readSeq: 2, lastSeq: 2, wake: { mode: 'auto' },
    createdAt: 0, lastProactiveAt: 0, messages: [{ seq: 1, self: false }, { seq: 2, self: false }],
  };
  chat.messages[1].time = Date.now() - 1000;
  const calls = [];
  const fake = {
    config,
    chats: new Map([['group:1', chat]]),
    scheduleTurn: (c, reason, delay, opts) => calls.push({ reason, opts }),
    log: { info: () => {} },
  };
  await Bridge.prototype.checkProactive.call(fake);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.proactive, true);
});

test('Bridge.flattenForward 解析转发节点', async () => {
  const { Bridge } = await import('../src/bridge.js');
  const fake = { config: { forward: { maxChars: 500, maxDepth: 2 } } };
  const text = Bridge.prototype.flattenForward.call(fake, {
    messages: [
      { sender: { nickname: '小明' }, message: [{ type: 'text', data: { text: '你好' } }] },
      { sender: { card: '小红' }, content: [{ type: 'text', data: { text: '在吗' } }] },
    ],
  });
  assert.match(text, /小明：你好/);
  assert.match(text, /小红：在吗/);
});

test('DshRuntime 提取 reasoning', async () => {
  const { DshRuntime } = await import('../src/dsh-sdk.js');
  const rt = new DshRuntime({ log: { info() {}, warn() {}, error() {}, debug() {} } });
  rt.trackEvent('s1', { type: 'turn/start' });
  rt.trackEvent('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '先想一下' }, { type: 'text', text: '好' }] }, usage: { inputTokens: 1 } } });
  const rec = rt.sessions.get('s1');
  assert.match(rec.reasoning, /先想一下/);
  assert.equal(rec.lastText, '好');
});

test('StickerStore 入库、按语境挑选与识别更新', async () => {
  const { StickerStore } = await import('../src/stickers.js');
  const config = tempConfig();
  config.sticker = { maxItems: 20 };
  fs.mkdirSync(path.join(config.paths.media, 'stickers'), { recursive: true });
  const file = path.join(config.paths.media, 'stickers', 'a.png');
  fs.writeFileSync(file, Buffer.from('fake-png'));
  const store = new StickerStore(config, null);
  const item = store.add({ file, note: '无语', tags: ['无语', '翻白眼'], source: 'auto' });
  assert.ok(item.id);
  store.update(item.id, { desc: '翻白眼', emotion: '无语', tags: ['无语'], recognized: true });
  const picked = store.pick({ text: '我真无语了', grudge: true });
  assert.equal(picked.id, item.id);
  assert.equal(store.stats().recognized, 1);
});

test('DshRuntime.prompt 支持图片 content block', async () => {
  const { DshRuntime } = await import('../src/dsh-sdk.js');
  const rt = new DshRuntime({ log: { info() {}, warn() {}, error() {}, debug() {} } });
  let captured = null;
  rt.request = async (method, params) => { captured = { method, params }; return {}; };
  const promise = rt.prompt('s-img', '看图', { images: [{ data: 'AAAA', mimeType: 'image/png' }] });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(captured.method, 'session/prompt');
  assert.equal(captured.params.contentBlocks[1].type, 'image');
  assert.equal(captured.params.contentBlocks[1].mimeType, 'image/png');
  rt.finishTurn('s-img', { reason: 'completed' });
  await promise;
});

test('buildOwnerPrompt 包含 agent 权限与令牌', async () => {
  const { buildOwnerPrompt } = await import('../src/prompt.js');
  const prompt = buildOwnerPrompt({
    chat: { kind: 'private', targetId: 1, token: 'owner-tok' },
    messages: [{ userId: 1, sender: { nickname: '主人' }, text: '看下 E:\dsh', images: [], files: [] }],
    self: { userId: 9, nickname: '小鲸鱼' },
  });
  assert.match(prompt, /owner-tok/);
  assert.match(prompt, /DSH agent/);
  assert.match(prompt, /mcp__qq__/);
});

test('htmlToArticle 去掉导航并保留正文', async () => {
  const { htmlToArticle } = await import('../src/web.js');
  const html = `<html><head><title>T</title><style>.x{}</style></head><body>
    <nav>首页 登录</nav><article><h1>标题</h1><p>第一段内容。</p><p>第二段。</p></article>
    <footer>版权</footer><script>alert(1)</script></body></html>`;
  const text = htmlToArticle(html);
  assert.match(text, /标题/);
  assert.match(text, /第一段内容/);
  assert.doesNotMatch(text, /首页|版权|alert/);
});

test('QQ 音乐与网易云搜索结果解析', async () => {
  const { parseQQSearch, parseNeteaseSearch } = await import('../src/music.js');
  const qq = parseQQSearch({ data: { song: { list: [{
    mid: '003abc', title: '起风了', interval: 312,
    singer: [{ name: '买辣椒也用券' }], album: { name: '起风了' }, pay: { pay_play: 0 },
  }] } } });
  assert.equal(qq[0].title, '起风了');
  assert.equal(qq[0].mid, '003abc');
  const ne = parseNeteaseSearch({ result: { songs: [{ id: 123, name: '晴天', artists: [{ name: '周杰伦' }], album: { name: '叶惠美' }, duration: 269000 }] } });
  assert.equal(ne[0].id, '123');
  assert.equal(ne[0].duration, 269);
});

test('本地音乐库能按文件名匹配', async () => {
  const { searchLocalMusic } = await import('../src/music.js');
  const config = tempConfig();
  const dir = path.join(config.paths.media, 'music');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '周杰伦 - 晴天.mp3');
  fs.writeFileSync(file, Buffer.alloc(30 * 1024, 1));
  config.music = { maxBytes: 10 * 1024 * 1024, localDirs: [dir], localIndexMinutes: 0 };
  const hit = searchLocalMusic('晴天 周杰伦', config);
  assert.equal(hit?.file, file);
  assert.equal(hit?.artist, '周杰伦');
  assert.equal(hit?.title, '晴天');
});

test('点歌失败时生成官方歌曲链接', async () => {
  const { songLink } = await import('../src/music.js');
  assert.match(songLink({ source: 'qq', mid: '003abc' }, '起风了'), /songDetail\/003abc/);
  assert.match(songLink({ source: 'netease', id: '123' }, '晴天'), /song\?id=123/);
  assert.match(songLink(null, '小鲸鱼'), /search\?w=/);
});

test('群聊主人 # 指令只认 owner 本人且前缀在最前面', async () => {
  const { parseOwnerCommand } = await import('../src/owner-command.js');
  const config = { qq: { ownerQQ: 10001 }, owner: { groupCommands: true, groupCommandPrefix: '#' } };
  const group = { kind: 'group' };
  assert.deepEqual(parseOwnerCommand({ chat: group, evt: { userId: 10001, text: '# 查下磁盘' }, config }), { ownerCommand: true, commandText: '查下磁盘' });
  assert.deepEqual(parseOwnerCommand({ chat: group, evt: { userId: 10001, text: '#重启一下' }, config }), { ownerCommand: true, commandText: '重启一下' });
  // 非 owner 带 # 不算
  assert.equal(parseOwnerCommand({ chat: group, evt: { userId: 20002, text: '#查下磁盘' }, config }).ownerCommand, false);
  // owner 但 # 不在最前面不算
  assert.equal(parseOwnerCommand({ chat: group, evt: { userId: 10001, text: '帮我 #查下磁盘' }, config }).ownerCommand, false);
  // 私聊不走这条逻辑
  assert.equal(parseOwnerCommand({ chat: { kind: 'private' }, evt: { userId: 10001, text: '#查下磁盘' }, config }).ownerCommand, false);
  // 关掉开关后全部不算
  assert.equal(parseOwnerCommand({ chat: group, evt: { userId: 10001, text: '#查下磁盘' }, config: { ...config, owner: { groupCommands: false } } }).ownerCommand, false);
});

test('表情包拉黑后不再被自动挑选，也能恢复', async () => {
  const { StickerStore } = await import('../src/stickers.js');
  const config = tempConfig();
  config.sticker = { maxItems: 10 };
  const dir = path.join(config.paths.media, 'stickers');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'unit.png');
  fs.writeFileSync(file, Buffer.alloc(64, 1));
  const store = new StickerStore(config, null);
  const item = store.add({ file, note: '测试图', source: 'unit' });
  assert.ok(item?.id);
  assert.equal(store.pick({ text: '测试图' })?.id, item.id);
  store.setDisabled(item.id, true);
  assert.equal(store.get(item.id).disabled, true);
  assert.equal(store.pick({ text: '测试图' }), null);
  assert.equal(store.stats().disabled, 1);
  store.setDisabled(item.id, false);
  assert.equal(store.pick({ text: '测试图' })?.id, item.id);
});

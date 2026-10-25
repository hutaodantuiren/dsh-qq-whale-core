import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { Bridge } from '../src/bridge.js';

function makeBridge() {
  const config = loadConfig();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-test-'));
  config.paths = {
    ...config.paths,
    state: path.join(dir, 'state'),
    logs: path.join(dir, 'logs'),
    memory: path.join(dir, 'memory'),
    avatars: path.join(dir, 'avatars'),
    media: path.join(dir, 'media'),
  };
  for (const key of ['state', 'logs', 'memory', 'avatars', 'media']) fs.mkdirSync(config.paths[key], { recursive: true });
  config.bridge.port = 0;
  const bridge = new Bridge(config, new Logger({ level: 'error' }));
  const chat = bridge.getChat({ chatType: 'group', groupId: 456789, groupName: '测试群' });
  return { bridge, chat };
}

test('wait_messages 在收到新消息后返回，并推进 seenSeq', async () => {
  const { bridge, chat } = makeBridge();
  const waiting = bridge.toolWaitMessages({ token: chat.token, timeoutMs: 2000, quietMs: 0, afterSeq: chat.lastSeq });
  setTimeout(() => {
    const entry = {
      seq: ++chat.lastSeq,
      messageId: 'm1',
      time: Date.now(),
      userId: 20001,
      sender: { nickname: '群友A', role: 'member' },
      text: '在吗',
      images: [],
      replyId: '',
      self: false,
    };
    chat.messages.push(entry);
    bridge.notifyWaiters(chat, entry);
  }, 50);
  const result = await waiting;
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, '在吗');
  assert.equal(result.readThroughSeq, chat.lastSeq);
});

test('mark_read 与 set_wake_config 更新状态', () => {
  const { bridge, chat } = makeBridge();
  chat.lastSeq = 10;
  chat.messages.push({ seq: 9, self: false, text: 'x' });
  const read = bridge.toolMarkRead({ token: chat.token, throughSeq: 9 });
  assert.equal(read.readSeq, 9);
  const wake = bridge.toolSetWakeConfig({ token: chat.token, config: { mode: 'diving', sleepMinutes: 1 }, throughSeq: 9 });
  assert.equal(wake.wake.mode, 'diving');
  assert.ok(wake.wake.sleepUntil > Date.now());
});

test('无效 token 被拒绝', () => {
  const { bridge } = makeBridge();
  assert.throws(() => bridge.toolMarkRead({ token: 'bad', throughSeq: 1 }), /令牌无效/);
});


test('大肥鱼是硬唤醒，能突破静默/睡眠/频率', async () => {
  const { bridge, chat } = makeBridge();
  chat.wake.mode = 'muted';
  chat.wake.sleepUntil = Date.now() + 3600000;
  chat.wakeTimes = [Date.now(), Date.now()];
  const decision = await bridge.shouldWake(chat, { text: '蓝色大肥鱼！', userId: 2, atSelf: false, replyId: '' });
  assert.equal(decision.wake, true);
  assert.equal(decision.grudge, true);
  assert.match(decision.reason, /大肥鱼/);
});

test('群里聊热了会自动结束潜水', async () => {
  const { bridge, chat } = makeBridge();
  bridge.config.wake.hotMessageCount = 1;
  bridge.config.wake.joinProbability = 1;
  bridge.config.wake.cooldownMs = 0;
  chat.wake.mode = 'diving';
  chat.wake.sleepUntil = 0;
  chat.social.state = 'diving';
  chat.social.lastJoinAt = 0;
  const decision = await bridge.shouldWake(chat, { text: '你们在聊什么', userId: 3, atSelf: false, replyId: '' });
  assert.equal(decision.wake, true);
  assert.equal(decision.autoJoin, true);
  assert.match(decision.reason, /自动结束潜水/);
});

test('回合结束后进入冷却并记录思考', async () => {
  const { bridge, chat } = makeBridge();
  chat.lastSeq = 5;
  await bridge.afterTurn(chat, { text: '[SILENT]', reasoning: '想了一下，决定不说', usage: null, durationMs: 1200 }, 5, { reason: '群里聊热了' });
  assert.equal(chat.social.state, 'cooling');
  assert.ok(chat.lastThinking.text.includes('决定不说'));
  assert.equal(chat.lastThinking.trigger, '群里聊热了');
});

test('工具调用进入决策轨迹，大肥鱼思考可在控制台展示', async () => {
  const { bridge, chat } = makeBridge();
  chat.running = true;
  chat.trace = [];
  bridge.noteToolCall('send_message', { token: chat.token, messages: ['？你再说一遍试试'] });
  bridge.noteToolCall('mute_member', { token: chat.token, userId: '20001', durationSeconds: 600 });
  await bridge.afterTurn(chat, { text: '？你再说一遍试试', reasoning: '有人踩雷了，先回怼', usage: null, durationMs: 800 }, chat.lastSeq, { reason: '有人叫你大肥鱼', grudge: true });
  assert.match(chat.lastThinking.trace, /send_message/);
  assert.match(chat.lastThinking.trace, /mute_member/);
  assert.match(chat.lastThinking.trace, /社交状态/);
  assert.ok(chat.lastThinking.grudge);
});

test('白名单增删会写回 config.json', () => {
  const { bridge } = makeBridge();
  const file = path.join(bridge.config.paths.state, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ qq: { allow: { private: [], groups: [] } } }, null, 2));
  bridge.config.paths.config = file;
  bridge.config.qq.allow = { private: [], groups: [] };
  let info = bridge.addWhitelist('group', '1085086913');
  assert.ok(info.allow.groups.includes('1085086913'));
  info = bridge.addWhitelist('private', '3351107931');
  assert.ok(info.allow.private.includes('3351107931'));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.qq.allow.groups, ['1085086913']);
  assert.deepEqual(saved.qq.allow.private, ['3351107931']);
  info = bridge.removeWhitelist('group', '1085086913');
  assert.ok(!info.allow.groups.includes('1085086913'));
  assert.throws(() => bridge.addWhitelist('group', 'abc'), /5~15/);
});

test('owner 私聊默认总是唤醒（agent 模式）', async () => {
  const { bridge, chat } = makeBridge();
  chat.kind = 'private';
  chat.targetId = bridge.config.qq.ownerQQ || 3351107931;
  chat.wake.mode = 'muted';
  chat.wake.sleepUntil = Date.now() + 3600000;
  assert.equal(bridge.isOwnerChat(chat), true);
  const decision = await bridge.shouldWake(chat, { text: '帮我看看项目', userId: chat.targetId, atSelf: false, replyId: '' });
  assert.equal(decision.wake, true);
  assert.match(decision.reason, /主人/);
});

test('改昵称工具会写 profile.json 并拒绝频繁修改', async () => {
  const { bridge } = makeBridge();
  bridge.onebot.nickname = '旧昵称';
  const calls = [];
  bridge.onebot.setNickname = async (name) => { calls.push(name); return { ok: true }; };
  const r = await bridge.toolSetNickname({ nickname: '小鲸鱼' });
  assert.equal(r.changed, true);
  assert.equal(r.nickname, '小鲸鱼');
  assert.deepEqual(calls, ['小鲸鱼']);
  await assert.rejects(() => bridge.toolSetNickname({ nickname: '另一个' }), /太频繁/);
});

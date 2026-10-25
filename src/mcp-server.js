#!/usr/bin/env node
/**
 * QQ MCP server：把桥接的控制面包装成 MCP 工具，供 DSH agent 调用。
 * 走 stdio 换行分隔 JSON-RPC；桥接地址与令牌从 state/runtime.json 读取。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HOME = process.env.QQ_BRIDGE_HOME || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_FILE = path.join(HOME, 'state', 'runtime.json');
const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'qq', version: '0.1.0' };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadRuntime() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const data = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
      if (data?.url && data?.token) return data;
    } catch {
      /* wait */
    }
    await sleep(300);
  }
  throw new Error(`桥接尚未启动或 runtime.json 不可读：${RUNTIME_FILE}`);
}

const runtime = await loadRuntime().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});

const TOOL_TIMEOUT_MS = 660000;

async function rpc(method, params) {
  const response = await fetch(`${runtime.url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': runtime.token },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || '桥接返回失败');
  return data.result;
}

const tokenProp = { type: 'string', description: '本次 QQ 会话的令牌（提示里的【会话令牌】）' };
const messagesProp = { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: '一条或多条消息文本' };

const TOOLS = [
  {
    name: 'send_message',
    description: '向当前 QQ 会话发送消息。messages 可以是字符串或字符串数组；数组会逐条发送，用于自然的连发。引用回复传 replyToMessageId，@人传 atUserId。',
    inputSchema: { type: 'object', properties: { token: tokenProp, messages: messagesProp, replyToMessageId: { type: 'string' }, atUserId: { type: 'string' } }, required: ['token', 'messages'] },
  },
  {
    name: 'reply',
    description: '引用某条消息回复。等价于 send_message + replyToMessageId。',
    inputSchema: { type: 'object', properties: { token: tokenProp, messageId: { type: 'string' }, messages: messagesProp, atUserId: { type: 'string' } }, required: ['token', 'messageId', 'messages'] },
  },
  {
    name: 'wait_messages',
    description: '等待新消息。purpose=reply 时按 quietMs 等对方把话说完（读取期间的新消息会重算静默）；purpose=messages 用于回复后蹲后续、或沉睡前 5 分钟观察。超时不代表错误。',
    inputSchema: {
      type: 'object',
      properties: {
        token: tokenProp,
        timeoutMs: { type: 'number', description: '最长等待毫秒，默认 30000，最大 600000' },
        quietMs: { type: 'number', description: '静默多少毫秒后返回（0 表示一有新消息立刻返回）' },
        purpose: { type: 'string', enum: ['messages', 'reply'], description: 'messages=普通等待，reply=等对方说完' },
        afterSeq: { type: 'number', description: '从哪个本地 seq 之后开始等，默认当前已读水位' },
      },
      required: ['token'],
    },
  },
  {
    name: 'mark_read',
    description: '把你已经看到的消息标为已读（提交读到的 waterline）。潜水收尾时用。',
    inputSchema: { type: 'object', properties: { token: tokenProp, throughSeq: { type: 'number', description: '读到的本地 seq 水位' } }, required: ['token'] },
  },
  {
    name: 'set_wake_config',
    description: '设置下一次唤醒策略：mode=active（每条都醒）/auto（按概率）/diving（只被@、名字、关键词、拍一拍、等待的人唤醒）/muted（完全静默）；可设置 sleepMinutes 潜水时长、probability、keywords、triggers（atMention/nameMention/keyword/question/poke/speakerIds）。同时可提交 readThroughSeq 标已读。',
    inputSchema: {
      type: 'object',
      properties: {
        token: tokenProp,
        config: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['active', 'auto', 'diving', 'muted'] },
            probability: { type: 'number' },
            sleepMinutes: { type: 'number' },
            keywords: { type: 'array', items: { type: 'string' } },
            triggers: { type: 'object' },
          },
        },
        throughSeq: { type: 'number' },
      },
      required: ['token', 'config'],
    },
  },
  {
    name: 'get_members',
    description: '查看群成员列表（QQ 号、昵称、身份）。私聊返回对方。',
    inputSchema: { type: 'object', properties: { token: tokenProp, limit: { type: 'number' } }, required: ['token'] },
  },
  {
    name: 'get_active_members',
    description: '查看最近在这个会话里说话的人，用于知道该 @ 谁、等谁。',
    inputSchema: { type: 'object', properties: { token: tokenProp, limit: { type: 'number' } }, required: ['token'] },
  },
  {
    name: 'get_message_detail',
    description: '按 messageId 查看缓存里的某条消息详情（引用、图片数量、发送者）。',
    inputSchema: { type: 'object', properties: { token: tokenProp, messageId: { type: 'string' } }, required: ['token', 'messageId'] },
  },
  {
    name: 'memory_append',
    description: '记一条轻量记忆：kind=topic（进行中的话题）/thought（想说未说）/impression（对某群友的印象，需 about）。',
    inputSchema: {
      type: 'object',
      properties: { token: tokenProp, kind: { type: 'string', enum: ['topic', 'thought', 'impression'] }, text: { type: 'string' }, about: { type: 'string' } },
      required: ['token', 'kind', 'text'],
    },
  },
  {
    name: 'memory_query',
    description: '查询当前会话的轻量记忆；term 为空返回全部。',
    inputSchema: { type: 'object', properties: { token: tokenProp, term: { type: 'string' } }, required: ['token'] },
  },
  {
    name: 'memory_remove',
    description: '删除匹配的轻量记忆。',
    inputSchema: { type: 'object', properties: { token: tokenProp, kind: { type: 'string', enum: ['topic', 'thought', 'impression'] }, text: { type: 'string' } }, required: ['token', 'text'] },
  },
  {
    name: 'memory_clear',
    description: '清空当前会话的轻量记忆。',
    inputSchema: { type: 'object', properties: { token: tokenProp }, required: ['token'] },
  },
  {
    name: 'slang_query',
    description: '查询群黑话/网络用语词典与候选词频。',
    inputSchema: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'] },
  },
  {
    name: 'slang_submit',
    description: '提交一条确认含义的黑话/梗，写入词典供以后自然使用。',
    inputSchema: {
      type: 'object',
      properties: { term: { type: 'string' }, meaning: { type: 'string' }, usage: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
      required: ['term', 'meaning'],
    },
  },
  {
    name: 'slang_list',
    description: '列出已收录黑话与高频候选。',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'balance',
    description: '查询 DeepSeek Harness 账户余额、今日消耗与桥接估算花费。群友问“你还剩多少钱”时用。',
    inputSchema: { type: 'object', properties: { token: tokenProp } },
  },
  {
    name: 'admin_status',
    description: '查询你在当前群的权限（群主/管理员/普通成员），决定能不能撤回或禁言。',
    inputSchema: { type: 'object', properties: { token: tokenProp }, required: ['token'] },
  },
  {
    name: 'recall_message',
    description: '撤回一条消息（需要你是管理员/群主，或撤回自己的消息）。可附 taunt 作为撤回后紧接着发出的一句嘲讽。',
    inputSchema: { type: 'object', properties: { token: tokenProp, messageId: { type: 'string' }, taunt: { type: 'string' } }, required: ['token', 'messageId'] },
  },
  {
    name: 'recall_last_self',
    description: '撤回你自己最近发送的一条消息（觉得刚才说得不合适时用）。可附 taunt。',
    inputSchema: { type: 'object', properties: { token: tokenProp, taunt: { type: 'string' } }, required: ['token'] },
  },
  {
    name: 'mute_member',
    description: '禁言群成员（需要管理员权限）。durationSeconds 默认 600，范围 60~86400；不能禁言群主/管理员/主人/自己。',
    inputSchema: {
      type: 'object',
      properties: { token: tokenProp, userId: { type: 'string' }, durationSeconds: { type: 'number' }, reason: { type: 'string' }, taunt: { type: 'string' } },
      required: ['token', 'userId'],
    },
  },
  {
    name: 'kick_member',
    description: '踢出群成员（只有群主可用，谨慎）。',
    inputSchema: { type: 'object', properties: { token: tokenProp, userId: { type: 'string' }, reason: { type: 'string' } }, required: ['token', 'userId'] },
  },
  {
    name: 'send_poke',
    description: '拍一拍对方。',
    inputSchema: { type: 'object', properties: { token: tokenProp, userId: { type: 'string' } }, required: ['token'] },
  },
  {
    name: 'find_avatar',
    description: '在网上搜索适合当头像的图片（默认搜 DeepSeek 小鲸鱼/蓝发/鲸鱼娘），下载到本机并返回路径与预览。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'set_avatar',
    description: '把本机图片设置为 QQ 头像（取决于 SnowLuma 是否支持 set_qq_avatar；失败会说明）。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'send_image',
    description: '发送本机图片到当前会话。',
    inputSchema: { type: 'object', properties: { token: tokenProp, path: { type: 'string' }, replyToMessageId: { type: 'string' } }, required: ['token', 'path'] },
  },
  {
    name: 'collect_sticker',
    description: '把某条消息里的图片收藏为表情包，附一句备注帮助以后识别。',
    inputSchema: { type: 'object', properties: { token: tokenProp, messageId: { type: 'string' }, note: { type: 'string' } }, required: ['token', 'messageId'] },
  },
  {
    name: 'sticker_note',
    description: '给已收藏的表情包补充识别结果/备注：画面内容、情绪、标签、适合场景。看过图之后用。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, desc: { type: 'string' }, emotion: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, usage: { type: 'string' }, note: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'list_stickers',
    description: '列出收藏的表情包。',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'send_sticker',
    description: '发送收藏的表情包（按 id）。被拉黑（永不录用）的会拒绝发送。',
    inputSchema: { type: 'object', properties: { token: tokenProp, id: { type: 'string' }, replyToMessageId: { type: 'string' } }, required: ['token', 'id'] },
  },
  {
    name: 'sticker_ban',
    description: '把某个表情包拉黑（永不录用）或恢复。拉黑后自动配图和 send_sticker 都不会再用它；只有主人要求时才用。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, disabled: { type: 'boolean', description: '默认 true 拉黑；false 恢复' } }, required: ['id'] },
  },
  {
    name: 'get_images',
    description: '获取某条消息里的图片，图片会以图像内容进入上下文。',
    inputSchema: { type: 'object', properties: { token: tokenProp, messageId: { type: 'string' }, limit: { type: 'number' } }, required: ['token', 'messageId'] },
  },
  {
    name: 'get_forward_msg',
    description: '展开一条合并转发消息（消息里的 [转发 id=...]）。返回每个节点的发送者和文本；嵌套转发会标出 id。',
    inputSchema: { type: 'object', properties: { token: tokenProp, id: { type: 'string', description: '转发 id' } }, required: ['token', 'id'] },
  },
  {
    name: 'transcribe_voice',
    description: '转写一条语音消息（需要 config.json 的 voice.command 或 voice.apiUrl 已配置）；返回文字。',
    inputSchema: { type: 'object', properties: { token: tokenProp, messageId: { type: 'string' } }, required: ['token', 'messageId'] },
  },
  {
    name: 'relation_get',
    description: '查看当前会话的好感度/关系：不传 userId 返回列表与摘要，传了返回单个群友。',
    inputSchema: { type: 'object', properties: { token: tokenProp, userId: { type: 'string' } }, required: ['token'] },
  },
  {
    name: 'relation_set',
    description: '微调对某个群友的好感（delta -5~5）并记一条备注/标签；用来记录“这人挺有意思/这人有点烦”。',
    inputSchema: {
      type: 'object',
      properties: { token: tokenProp, userId: { type: 'string' }, delta: { type: 'number' }, note: { type: 'string' }, tag: { type: 'string' } },
      required: ['token', 'userId'],
    },
  },
  {
    name: 'diary_read',
    description: '读小鲸鱼日记：不传 date 返回最近列表，传 date 返回某天的日记；带 token 时优先返回当前会话的。',
    inputSchema: { type: 'object', properties: { token: tokenProp, date: { type: 'string', description: 'YYYY-MM-DD' } } },
  },
  {
    name: 'archive_list',
    description: '列出当前会话归档的群图片/文件（可按日期过滤）。',
    inputSchema: { type: 'object', properties: { token: tokenProp, date: { type: 'string' }, limit: { type: 'number' } }, required: ['token'] },
  },
  {
    name: 'archive_stats',
    description: '查看当前会话/全局的图片文件归档统计。',
    inputSchema: { type: 'object', properties: { token: tokenProp } },
  },
  {
    name: 'set_nickname',
    description: '修改机器人自己的 QQ 昵称（set_qq_profile）。一小时最多一次；别改成链接/广告/违规内容。',
    inputSchema: { type: 'object', properties: { nickname: { type: 'string', description: '新昵称，最长 20 字' } }, required: ['nickname'] },
  },
  {
    name: 'play_song',
    description: '点歌：优先本机音乐库（QQ 音乐客户端下载目录）；没有就用 dsh-song-download 插件（B 站/YouTube + yt-dlp）下载 MP3；插件失败再回退 QQ 音乐/网易云的免费音源。以 QQ 语音消息发送。VIP/付费/版权受限会跳过，不模拟登录、不绕过会员；找不到就如实说。',
    inputSchema: {
      type: 'object',
      properties: {
        token: tokenProp,
        query: { type: 'string', description: '歌名或“歌手 歌名”' },
        replyToMessageId: { type: 'string' },
        sendAsVoice: { type: 'boolean', description: '默认 true；false 则发音频文件' },
      },
      required: ['token', 'query'],
    },
  },
  {
    name: 'play_video',
    description: '发视频：按关键词搜 B 站（bilisearch）或直接给 B 站链接/BV 号，用 yt-dlp 下载 MP4 并以 QQ 视频消息发送。默认只发 10 分钟以内、720p 以下、60MB 以内的视频；超限/失败会如实说，不绕过任何限制。',
    inputSchema: {
      type: 'object',
      properties: {
        token: tokenProp,
        query: { type: 'string', description: '关键词，如“猫 搞笑”' },
        url: { type: 'string', description: 'B 站链接、b23.tv 短链或 BV 号（与 query 二选一，优先）' },
        replyToMessageId: { type: 'string' },
        sendAsFile: { type: 'boolean', description: '默认 false；true 则发文件而不是视频消息' },
      },
      required: ['token'],
    },
  },
  {
    name: 'read_website',
    description: '读取一个公网网页的标题和正文（去广告/导航，带 SSRF 防护）。群友发链接或问某个网站里的内容时先读再答。',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'web_search',
    description: '联网搜索（Bing / DuckDuckGo），返回标题、链接、摘要。查网络用语、时事、资料时用。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'web_fetch',
    description: '抓取一个公网 URL 的正文（带 SSRF 防护，只允许 http/https 公网地址）。',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
];

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

async function callTool(name, args) {
  const result = await rpc(`tool.${name}`, args || {});
  if (result && Array.isArray(result.images) && result.images.length) {
    const content = result.images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType }));
    content.push({ type: 'text', text: `已获取 ${result.images.length} 张图片（${result.images.map((i) => `${Math.round(i.bytes / 1024)}KB`).join('、')}）。` });
    return { content };
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: 'text', text: text.length > 20000 ? `${text.slice(0, 20000)}\n…（已截断）` : text }] };
}

async function handleRequest(msg) {
  const { id, method, params = {} } = msg;
  try {
    switch (method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: 'QQ 群聊工具。聊天类工具都需要提示中的【会话令牌】token。文本输出不会自动发到 QQ，发言必须调用 send_message。',
          },
        });
      case 'notifications/initialized':
        return;
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const name = params.name;
        const args = params.arguments || {};
        if (!TOOLS.some((tool) => tool.name === name)) throw new Error(`未知工具：${name}`);
        const result = await callTool(name, args);
        return send({ jsonrpc: '2.0', id, result });
      }
      case 'resources/list':
        return send({ jsonrpc: '2.0', id, result: { resources: [] } });
      case 'prompts/list':
        return send({ jsonrpc: '2.0', id, result: { prompts: [] } });
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (error) {
    const result = { content: [{ type: 'text', text: `工具执行失败：${error.message}` }], isError: true };
    send({ jsonrpc: '2.0', id, result });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.method && msg.id !== undefined) {
    handleRequest(msg).catch((error) => {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: error.message } });
    });
  }
});

process.stdin.on('end', () => process.exit(0));

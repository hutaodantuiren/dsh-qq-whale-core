import { clamp } from './util.js';

const HOSTILE_PATTERNS = [
  { re: /大肥鱼|肥鱼|胖鱼|肥鲶鱼/g, weight: 2, label: '大肥鱼' },
  { re: /人工智障|智障|弱智|傻逼|傻b|sb|废物|垃圾ai|垃圾AI/g, weight: 3, label: '辱骂' },
  { re: /闭嘴|滚(吧|开|出去)?|别说话|烦不烦/g, weight: 2, label: '驱赶' },
  { re: /不如\s*(claude|gpt|gemini|豆包|kimi)|被?秒杀|就这\??/gi, weight: 2, label: '贬低' },
  { re: /你是?a[iI]|一眼ai|AI味/g, weight: 1, label: 'AI 质疑' },
];

const AI_PHRASES = [
  '首先', '其次', '综上所述', '总而言之', '值得注意的是', '希望对你有帮助',
  '有什么可以帮', '随时找我', '作为AI', '作为一个语言模型', '这是个好问题',
  '我理解你的感受', '记得', '一定要', '加油！', '宝子', '亲亲', '哦～', '呢～',
];

export function analyzeHostility(text) {
  const value = String(text || '');
  let score = 0;
  const labels = [];
  for (const pattern of HOSTILE_PATTERNS) {
    pattern.re.lastIndex = 0;
    if (pattern.re.test(value)) {
      score += pattern.weight;
      labels.push(pattern.label);
    }
  }
  return { score, labels: [...new Set(labels)], hostile: score >= 2 };
}

export function shouldSelfRecall(text, config) {
  const value = String(text || '');
  if (!config.admin?.autoSelfRecall?.enabled) return { recall: false };
  if (value.length > (config.admin.autoSelfRecall.maxChars || 300)) return { recall: true, reason: 'too-long' };
  if (/^\s{0,3}#{1,6}\s/m.test(value) || /\*\*[^*]+\*\*/.test(value) || /```/.test(value)) {
    return { recall: true, reason: 'markdown' };
  }
  const phrases = config.admin.autoSelfRecall.phrases || AI_PHRASES;
  for (const phrase of phrases) {
    if (phrase && value.includes(phrase)) return { recall: true, reason: `ai-phrase:${phrase}` };
  }
  return { recall: false };
}

export class AdminService {
  constructor({ config, onebot, log }) {
    this.config = config;
    this.onebot = onebot;
    this.log = log;
    this.roleCache = new Map();
  }

  async selfRole(groupId) {
    const key = String(groupId);
    const cached = this.roleCache.get(key);
    if (cached && Date.now() - cached.at < 60000) return cached;
    const selfId = this.onebot.selfId;
    if (!selfId) return { role: 'member', canManage: false, userId: 0 };
    try {
      const info = await this.onebot.getGroupMemberInfo(groupId, selfId);
      const role = info?.role || 'member';
      const value = { role, canManage: role === 'owner' || role === 'admin', userId: selfId, nickname: info?.card || info?.nickname || this.onebot.nickname, at: Date.now() };
      this.roleCache.set(key, value);
      return value;
    } catch (error) {
      this.log?.warn?.(`查询自身群权限失败：${error.message}`);
      return { role: 'member', canManage: false, userId: selfId };
    }
  }

  async targetInfo(groupId, userId) {
    try {
      const info = await this.onebot.getGroupMemberInfo(groupId, userId);
      return {
        userId: Number(userId),
        nickname: info?.card || info?.nickname || `QQ${userId}`,
        role: info?.role || 'member',
      };
    } catch {
      return { userId: Number(userId), nickname: `QQ${userId}`, role: 'member' };
    }
  }

  async recall(chat, messageId, { bySelf = false, operatorQQ = null } = {}) {
    if (!this.config.admin?.enabled) throw new Error('群管理功能未启用');
    if (chat.kind !== 'group') {
      // 私聊只能撤回自己发的消息。
      if (!bySelf) throw new Error('私聊里只能撤回自己发送的消息');
    } else if (!bySelf) {
      const role = await this.selfRole(chat.targetId);
      if (!role.canManage) throw new Error(`没有撤回权限（当前群身份：${role.role}）`);
    }
    await this.onebot.recall(messageId);
    return { ok: true, messageId: String(messageId) };
  }

  async mute(chat, targetId, durationSeconds, { operatorQQ = null } = {}) {
    if (!this.config.admin?.enabled) throw new Error('群管理功能未启用');
    if (chat.kind !== 'group') throw new Error('禁言只能在群聊里使用');
    const role = await this.selfRole(chat.targetId);
    if (!role.canManage) throw new Error(`没有禁言权限（当前群身份：${role.role}）`);
    if (Number(targetId) === Number(this.onebot.selfId)) throw new Error('不能禁言自己');
    if (this.config.admin.protectOwner && this.config.qq.ownerQQ && Number(targetId) === Number(this.config.qq.ownerQQ)) {
      throw new Error('不能禁言主人');
    }
    const target = await this.targetInfo(chat.targetId, targetId);
    if (this.config.admin.protectAdmins && (target.role === 'owner' || target.role === 'admin')) {
      throw new Error(`不能禁言群${target.role === 'owner' ? '主' : '管理员'}：${target.nickname}`);
    }
    const duration = clamp(Number(durationSeconds) || this.config.admin.defaultMuteSeconds, this.config.admin.minMuteSeconds, this.config.admin.maxMuteSeconds);
    await this.onebot.setGroupBan(chat.targetId, targetId, duration);
    return { ok: true, target, duration, operatorQQ };
  }

  async kick(chat, targetId, rejectAddRequest = false) {
    if (!this.config.admin?.enabled) throw new Error('群管理功能未启用');
    if (chat.kind !== 'group') throw new Error('踢人只能在群聊里使用');
    const role = await this.selfRole(chat.targetId);
    if (role.role !== 'owner') throw new Error('只有群主才能踢人');
    if (this.config.admin.protectOwner && this.config.qq.ownerQQ && Number(targetId) === Number(this.config.qq.ownerQQ)) {
      throw new Error('不能踢主人');
    }
    const target = await this.targetInfo(chat.targetId, targetId);
    if (this.config.admin.protectAdmins && (target.role === 'owner' || target.role === 'admin')) {
      throw new Error(`不能踢群${target.role === 'owner' ? '主' : '管理员'}：${target.nickname}`);
    }
    await this.onebot.setGroupKick(chat.targetId, targetId, rejectAddRequest);
    return { ok: true, target };
  }
}

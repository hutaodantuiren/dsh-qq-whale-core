/**
 * 群聊里的「主人指令」识别：只有 ownerQQ 本人、且前缀在最前面时才成立。
 * 单独放一个模块，方便单测和别处复用（不是靠消息内容判断，而是靠 OneBot 事件的 userId）。
 */

export function ownerCommandPrefix(config) {
  if (config?.owner?.groupCommands === false) return '';
  return String(config?.owner?.groupCommandPrefix ?? '#');
}

export function isOwnerUser(config, userId) {
  const owner = config?.qq?.ownerQQ;
  if (!owner) return false;
  return Number(userId) === Number(owner);
}

/**
 * @returns {{ownerCommand:boolean, commandText:string}}
 */
export function parseOwnerCommand({ chat, evt, config } = {}) {
  const none = { ownerCommand: false, commandText: '' };
  if (chat?.kind !== 'group') return none;
  const prefix = ownerCommandPrefix(config);
  if (!prefix) return none;
  if (!isOwnerUser(config, evt?.userId)) return none;
  const text = String(evt?.text || '');
  if (!text.startsWith(prefix)) return none;
  return { ownerCommand: true, commandText: text.slice(prefix.length).trim() };
}

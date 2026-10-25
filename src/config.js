import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepMerge, readJson, writeJsonAtomic, clamp } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = process.env.QQ_BRIDGE_HOME
  ? path.resolve(process.env.QQ_BRIDGE_HOME)
  : path.resolve(__dirname, '..');

export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

function detectDshCommand() {
  const candidates = [
    process.env.DSH_CLI,
    process.env.DSH_COMMAND,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    'E:\\code\\deepseekharness\\resources\\runtime\\cli\\bin\\dsh.cmd',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'dsh';
}

export function loadConfig() {
  const configFile = path.join(PROJECT_ROOT, 'config.json');
  const exampleFile = path.join(PROJECT_ROOT, 'config.example.json');
  const defaults = readJson(exampleFile, {});
  const userConfig = readJson(configFile, null);
  if (!userConfig) {
    throw new Error(`缺少配置文件：${configFile}\n请先运行 npm run setup，或复制 config.example.json 为 config.json 后编辑。`);
  }
  const config = deepMerge(defaults, userConfig);

  config.paths = {
    root: PROJECT_ROOT,
    config: configFile,
    state: path.join(PROJECT_ROOT, 'state'),
    workspace: config.dsh.workspace ? path.resolve(PROJECT_ROOT, config.dsh.workspace) : path.join(PROJECT_ROOT, 'workspace'),
    patch: config.dsh.patch ? path.resolve(PROJECT_ROOT, config.dsh.patch) : path.join(PROJECT_ROOT, 'dsh', 'qq.patch.generated.yml'),
    ownerWorkspace: config.owner?.workspace ? path.resolve(PROJECT_ROOT, config.owner.workspace) : path.join(PROJECT_ROOT, 'workspace-owner'),
    ownerPatch: config.owner?.patch ? path.resolve(PROJECT_ROOT, config.owner.patch) : path.join(PROJECT_ROOT, 'dsh', 'owner.patch.generated.yml'),
    logs: path.join(PROJECT_ROOT, 'state', 'logs'),
    avatars: path.join(PROJECT_ROOT, 'state', 'avatars'),
    media: path.join(PROJECT_ROOT, 'state', 'media'),
    memory: path.join(PROJECT_ROOT, 'state', 'memory'),
  };
  for (const dir of [config.paths.state, config.paths.logs, config.paths.avatars, config.paths.media, config.paths.memory, config.paths.ownerWorkspace]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  if (!config.dsh.command) config.dsh.command = detectDshCommand();
  // 空字符串 = 不指定 reasoning effort（部分自建 provider 的模型不支持该参数）。
  config.dsh.reasoningEffort = config.dsh.reasoningEffort == null ? 'low' : String(config.dsh.reasoningEffort);
  config.dsh.maxTokens = clamp(config.dsh.maxTokens ?? 4096, 128, 32768);
  config.dsh.turnTimeoutMs = clamp(config.dsh.turnTimeoutMs ?? 900000, 30000, 3600000);

  config.wake.defaultProbability = clamp(config.wake.defaultProbability, 0, 1);
  config.wake.cooldownMs = clamp(config.wake.cooldownMs, 0, 3600000);
  config.chat.batchWindowMs = clamp(config.chat.batchWindowMs, 0, 60000);
  config.chat.maxBatchMessages = clamp(config.chat.maxBatchMessages, 1, 100);
  config.chat.maxReplyChars = clamp(config.chat.maxReplyChars, 20, 2000);
  config.admin.minMuteSeconds = clamp(config.admin.minMuteSeconds, 1, 2592000);
  config.admin.maxMuteSeconds = clamp(config.admin.maxMuteSeconds, config.admin.minMuteSeconds, 2592000);

  if (!config.balance.usageFile) config.balance.usageFile = path.join(DSH_HOME, '.dshw-usage.json');
  else config.balance.usageFile = path.resolve(PROJECT_ROOT, config.balance.usageFile);

  // 控制令牌：配置为空时使用 state/bridge-token（首次启动自动生成）。
  if (!config.bridge.token) {
    const tokenFile = path.join(config.paths.state, 'bridge-token');
    try {
      config.bridge.token = fs.readFileSync(tokenFile, 'utf8').trim();
    } catch {
      config.bridge.token = '';
    }
  }

  return config;
}

export function saveRuntimeState(paths, value) {
  writeJsonAtomic(path.join(paths.state, 'state.json'), value);
}

export function loadRuntimeState(paths) {
  return readJson(path.join(paths.state, 'state.json'), null);
}

export function saveRuntimeInfo(paths, value) {
  writeJsonAtomic(path.join(paths.state, 'runtime.json'), value);
}

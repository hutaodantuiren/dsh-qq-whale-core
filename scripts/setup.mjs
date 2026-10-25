#!/usr/bin/env node
/**
 * 安装 / 更新 DSH 端的 QQ 桥接配置：
 *   1. 生成 DSH profile patch（禁用本地工具、注入鲸鱼娘人格、挂载 QQ MCP）
 *   2. 由 prompts/*.md 合成工作区 AGENTS.md
 *   3. 生成 Windows 启动脚本
 * 用法：node scripts/setup.mjs [--check]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CHECK_ONLY = process.argv.includes('--check');

const DISABLE_ROWS = [
  'tool-plugin-manager',
  'tool-working-directory',
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'tool-fs',
  'tool-fs-search',
  'tool-skill',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-workflow',
  'tool-todo',
  'tool-goal',
  'tool-web',
  'plan-mode',
  'command-compact',
  'subagent',
  'subagent-spawn-in-process',
  'subagent-fork-in-process',
  'workflow-ptc',
  'ptc-runtime',
];

function q(value) {
  return JSON.stringify(String(value));
}

function ensureConfig() {
  const configFile = path.join(ROOT, 'config.json');
  if (fs.existsSync(configFile)) return false;
  fs.copyFileSync(path.join(ROOT, 'config.example.json'), configFile);
  return true;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function composeAgents() {
  const header = [
    '# 工作区：QQ 聊天（DeepSeek 小鲸鱼）',
    '',
    '你正在 DeepSeek Harness 的 QQ 桥接工作区里运行。你的身份是混在 QQ 群里的 DeepSeek 小鲸鱼（鲸鱼娘），不是客服、不是助手、不是百科全书。',
    '',
    '下面两节是本工作区的最高行为准则：先读角色卡，再读二代仿真协议。工具调用、分条、潜水、唤醒、群管理都以协议为准。',
    '',
    '---',
    '',
  ].join('\n');
  const role = fs.readFileSync(path.join(ROOT, 'workspace', 'prompts', 'role-card.md'), 'utf8');
  const simulation = fs.readFileSync(path.join(ROOT, 'workspace', 'prompts', 'simulation.md'), 'utf8');
  const text = `${header}${role}\n\n---\n\n${simulation}`;
  fs.writeFileSync(path.join(ROOT, 'workspace', 'AGENTS.md'), text, 'utf8');
  return text.length;
}

function buildPatch() {
  const config = readJson(path.join(ROOT, 'config.json'), {});
  const nodeExe = process.execPath;
  const systemPrompt = fs.readFileSync(path.join(ROOT, 'workspace', 'prompts', 'system.md'), 'utf8').trim();
  const lines = [];
  lines.push('# 由 scripts/setup.mjs 生成；改人格请编辑 workspace/prompts/ 后重新运行。');
  lines.push('# 用法：dsh --profile sdk --patch <本文件>');
  lines.push('');
  lines.push('- id: system-prompt');
  lines.push('  config:');
  lines.push('    includeHarnessIdentity: false');
  lines.push('    includeRuntimeContext: false');
  lines.push(`    personaPrefix: ${q(systemPrompt)}`);
  lines.push('');
  for (const id of DISABLE_ROWS) {
    lines.push(`- id: ${id}`);
    lines.push('  disabled: true');
  }
  lines.push('');
  lines.push('- insert:');
  lines.push('    - id: mcp-qq');
  lines.push("      name: '@deepseek-ai/dsh-mcp-client'");
  lines.push('      config:');
  lines.push('        serverName: qq');
  lines.push('        transport: stdio');
  lines.push(`        command: ${q(nodeExe)}`);
  lines.push('        args:');
  lines.push(`          - ${q(path.join(ROOT, 'src', 'mcp-server.js'))}`);
  lines.push('        env:');
  lines.push(`          QQ_BRIDGE_HOME: ${q(ROOT)}`);
  lines.push('        toolCallTimeoutMs: 660000');
  lines.push('        reconnect:');
  lines.push('          enabled: true');
  lines.push('          maxAttempts: 30');
  lines.push('');
  lines.push('- insert:');
  lines.push('    - id: mcp-web-search-safe');
  lines.push("      name: '@deepseek-ai/dsh-mcp-client'");
  lines.push('      config:');
  lines.push('        serverName: web-search-safe');
  lines.push('        transport: stdio');
  lines.push(`        command: ${q(nodeExe)}`);
  lines.push('        args:');
  lines.push(`          - ${q(path.join(ROOT, 'src', 'mcp-web-server.js'))}`);
  lines.push('        env:');
  lines.push(`          QQ_BRIDGE_HOME: ${q(ROOT)}`);
  lines.push('        toolCallTimeoutMs: 130000');
  lines.push('        reconnect:');
  lines.push('          enabled: true');
  lines.push('          maxAttempts: 30');
  lines.push('');
  lines.push('# 让 QQ 会话安静一点：关闭自动标题生成（可选）。');
  lines.push('- id: session-title-llm');
  lines.push('  disabled: true');
  lines.push('');
  const target = path.join(ROOT, 'dsh', 'qq.patch.generated.yml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
  return { target, config, nodeExe };
}

function buildOwnerPatch() {
  const nodeExe = process.execPath;
  const ownerDir = path.join(ROOT, 'workspace-owner');
  fs.mkdirSync(ownerDir, { recursive: true });
  const agentsFile = path.join(ownerDir, 'AGENTS.md');
  if (!fs.existsSync(agentsFile)) {
    fs.writeFileSync(agentsFile, `# 主人私聊 · DSH agent 模式

你是主人的私人 DSH agent，通过 QQ 私聊服务主人。

- 可以使用本地工具：bash / 文件读写 / 搜索 / 子代理 / 工作流。
- 也可以使用 \`mcp__qq__*\` QQ 工具；每条提示里会带【会话令牌】。
- 最终文本会自动转发到 QQ；要主动发消息、图片、撤回、禁言、查余额时，用对应的 QQ 工具。
- 回答简洁；代码/文件/排查可以正常展开，但不要用 Markdown 表格。
`, 'utf8');
  }
  const persona = `你是主人的私人 DSH agent。主人私聊你，或在群里发 # 开头的指令时，都由你执行。你可以使用本地工具（bash / 文件 / 搜索 / 子代理 / 工作流）和 mcp__qq__* QQ 工具。最终文本会自动发回当前会话；需要主动发消息/图片/管理群时用 QQ 工具并带上会话令牌。回答简洁，不要输出 Markdown 表格；群聊里别贴本地路径和令牌。`;
  const lines = [];
  lines.push('# 由 scripts/setup.mjs 生成；owner 私聊专用（完整 agent + QQ 工具）。');
  lines.push('');
  lines.push('- id: system-prompt');
  lines.push('  config:');
  lines.push('    includeHarnessIdentity: false');
  lines.push('    includeRuntimeContext: true');
  lines.push(`    personaPrefix: ${q(persona)}`);
  lines.push('');
  const mcp = (id, serverName, script) => {
    lines.push('- insert:');
    lines.push(`    - id: ${id}`);
    lines.push("      name: '@deepseek-ai/dsh-mcp-client'");
    lines.push('      config:');
    lines.push(`        serverName: ${serverName}`);
    lines.push('        transport: stdio');
    lines.push(`        command: ${q(nodeExe)}`);
    lines.push('        args:');
    lines.push(`          - ${q(path.join(ROOT, 'src', script))}`);
    lines.push('        env:');
    lines.push(`          QQ_BRIDGE_HOME: ${q(ROOT)}`);
    lines.push('        toolCallTimeoutMs: 660000');
    lines.push('        reconnect:');
    lines.push('          enabled: true');
    lines.push('          maxAttempts: 30');
    lines.push('');
  };
  mcp('mcp-qq-owner', 'qq', 'mcp-server.js');
  mcp('mcp-web-owner', 'web-search-safe', 'mcp-web-server.js');
  lines.push('- id: session-title-llm');
  lines.push('  disabled: true');
  lines.push('');
  const target = path.join(ROOT, 'dsh', 'owner.patch.generated.yml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
  return { target };
}

function checkProfile(dshCommand) {
  if (!dshCommand) return { ok: false, detail: '未找到 dsh 命令' };
  const isCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(dshCommand);
  const command = isCmd ? process.env.ComSpec || 'cmd.exe' : dshCommand;
  const args = isCmd ? ['/d', '/c', 'call', dshCommand, '--profile', 'sdk', '--dump-config'] : ['--profile', 'sdk', '--dump-config'];
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000, windowsHide: true });
  return { ok: result.status === 0, detail: result.status === 0 ? '' : (result.stderr || '').slice(-500) };
}

function writeLaunchers() {
  const nodeExe = process.execPath;
  const crlf = (lines) => lines.join('\r\n') + '\r\n';
  const common = ['@echo off', 'chcp 65001 >nul'];
  fs.writeFileSync(path.join(ROOT, 'start-qq-bridge.cmd'), crlf([
    ...common,
    'title DeepSeek 小鲸鱼 QQ 桥接',
    'cd /d "%~dp0"',
    `"${nodeExe}" src/main.js`,
    'pause',
  ]), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'restart-qq-bridge.cmd'), crlf([
    ...common,
    'title DeepSeek 小鲸鱼 QQ 桥接',
    'cd /d "%~dp0"',
    'echo 停止旧实例（若在运行）...',
    'taskkill /FI "WINDOWTITLE eq DeepSeek 小鲸鱼 QQ 桥接*" /F >nul 2>nul',
    `"${nodeExe}" src/main.js`,
    'pause',
  ]), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'install-qq-bridge.cmd'), crlf([
    ...common,
    'title 安装 DeepSeek 小鲸鱼 QQ 桥接',
    'cd /d "%~dp0"',
    `"${nodeExe}" scripts/setup.mjs`,
    'pause',
  ]), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'doctor-qq-bridge.cmd'), crlf([
    ...common,
    'title 自检 DeepSeek 小鲸鱼 QQ 桥接',
    'cd /d "%~dp0"',
    `"${nodeExe}" scripts/doctor.mjs`,
    'pause',
  ]), 'utf8');
}

function main() {
  console.log('🐳 DeepSeek 小鲸鱼 QQ 桥接 · DSH 端安装');
  console.log(`项目目录：${ROOT}`);
  console.log(`DSH_HOME：${DSH_HOME}`);

  if (!fs.existsSync(path.join(ROOT, 'workspace', 'prompts', 'role-card.md'))) {
    console.error('缺少 workspace/prompts/role-card.md，无法继续。');
    process.exit(1);
  }

  const created = ensureConfig();
  if (created) console.log('已创建 config.json（来自 config.example.json），请先填写 SnowLuma 地址与白名单。');

  const config = readJson(path.join(ROOT, 'config.json'), {});
  const candidates = [
    config?.dsh?.command,
    process.env.DSH_CLI,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    'E:/code/deepseekharness/resources/runtime/cli/bin/dsh.cmd',
  ].filter(Boolean);
  const dshCommand = candidates.find((candidate) => fs.existsSync(candidate)) || 'dsh';
  const profile = checkProfile(dshCommand);
  console.log(profile.ok ? '✓ DSH sdk profile 可用' : `⚠ DSH sdk profile 检查失败：${profile.detail}`);

  const agentsBytes = composeAgents();
  console.log(`✓ 已合成 workspace/AGENTS.md（${agentsBytes} 字节）`);

  const { target } = buildPatch();
  console.log(`✓ 已生成 DSH patch：${target}`);
  const owner = buildOwnerPatch();
  console.log(`✓ 已生成 owner patch：${owner.target}`);
  writeLaunchers();
  console.log('✓ 已生成 start-qq-bridge.cmd / restart-qq-bridge.cmd');

  for (const dir of ['state', 'state/logs', 'state/avatars', 'state/media', 'state/memory', 'state/archive', 'workspace/diary']) {
    fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
  }

  if (CHECK_ONLY) {
    console.log('（--check：仅检查，不启动）');
    return;
  }

  console.log('');
  console.log('下一步：');
  console.log('  1. 编辑 config.json：snowluma.httpUrl / wsUrl / accessToken，qq.allow.groups / private，qq.ownerQQ');
  console.log('  2. 确保 SnowLuma 已开启 OneBot HTTP API 与 WebSocket 服务端');
  console.log('  3. 双击 doctor-qq-bridge.cmd 做连通性检查');
  console.log('  4. 双击 start-qq-bridge.cmd 启动；控制台地址会打印在日志里');
  if (created) console.log('  ⚠ 这是第一次安装：config.json 里的白名单为空，默认不会响应任何消息。');
}

main();

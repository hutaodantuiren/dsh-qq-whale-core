# DSH 端集成说明

本目录只有一份**生成物** `qq.patch.generated.yml`，由 `node scripts/setup.mjs` 生成，不要手改。

## 它做了什么

DSH 的 `sdk` profile 默认是一个「编码 agent」：带 bash、文件读写、子代理、工作流等工具。QQ 群里任何人都可能说话，所以必须把这些本地工具全部关掉，只留 QQ 工具。

patch 覆盖在 `dsh --profile sdk` 之上：

1. `system-prompt`：关闭 harness identity 与 runtime context，换成小鲸鱼引导（完整角色卡在 `workspace/AGENTS.md`）。
2. 关闭所有本地工具行：bash / pwsh / fs / fs-search / subagent / workflow / skill / jobs / todo / goal / web / plan / plugin-manager / working-directory / ptc。
3. `insert` 两个 MCP client 行：
   - `qq`：stdio 启动 `src/mcp-server.js`，31 个 QQ 工具；`toolCallTimeoutMs: 660000`（要覆盖 5~10 分钟等待）
   - `web-search-safe`：stdio 启动 `src/mcp-web-server.js`，只读 `web_search` / `web_fetch`；与角色卡里的工具名一致
4. 关闭自动标题 LLM（QQ 会话不需要，省 token）。

## 怎么用

桥接进程会自动执行：

```bash
dsh --profile sdk --patch <项目>\dsh\qq.patch.generated.yml
```

也可以手动验证：

```bash
dsh --profile sdk --patch .\dsh\qq.patch.generated.yml --dump-config
```

`--patch` 只影响这一次进程，不会写入 `~/.dsh` 的持久配置。

## 改人格

不要改这个 patch。改：

- `workspace/prompts/role-card.md`：角色卡
- `workspace/prompts/simulation.md`：仿真协议
- `workspace/prompts/system.md`：system prompt 引导

然后重新运行：

```bash
node scripts/setup.mjs
```

它会重新合成 `workspace/AGENTS.md` 和本 patch。

## 安全提醒

如果 patch 不存在，桥接会**拒绝启动 DSH**（见 `src/bridge.js` 的 `startDsh`）。这是有意的：没有 patch 时 SDK 会暴露本地工具，QQ 群友可能诱导模型操作你的电脑。

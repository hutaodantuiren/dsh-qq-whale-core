# 快速部署（DSH + SnowLuma）

> 目标：克隆仓库后 5 分钟内让 QQ 机器人跑起来。

## 0. 前置

1. **DeepSeek Harness** 已安装并登录（桌面版即可）。
2. **SnowLuma** 已安装并登录 QQ，开启 OneBot v11：
   - HTTP API（默认 `127.0.0.1:3000`）
   - WebSocket 服务端（默认 `127.0.0.1:3001`）
   - 记下两个 access token（SnowLuma 的 `httpServers[].accessToken` 和 `wsServers[].accessToken`，可能不一样）。
3. Windows 10/11；Node.js 可选（安装脚本会自动找 DSH 自带的 node.exe）。

## 1. 获取代码

```bash
git clone https://github.com/hutaodantuiren/dsh-qq-whale.git dsh-qq-whale
cd dsh-qq-whale
```

或者解压 zip 到任意目录。

## 2. 一键安装

双击：

```
install.cmd
```

它会：

- 找到 DSH 自带 Node（或系统 Node）；
- 复制 `config.example.json` → `config.json`（首次）；
- 生成 `workspace/AGENTS.md`（鲸鱼娘人格 + 仿真协议）；
- 生成 `dsh/qq.patch.generated.yml`（受限 QQ 模式）；
- 生成 `dsh/owner.patch.generated.yml`（主人完整 agent 模式）；
- 生成 `workspace-owner/AGENTS.md`；
- 生成本机启动脚本。

> 需要 Node.js ≥ 22.13。没有装 Node、也找不到 DSH 自带 node 时，先装 Node。

## 3. 填配置

编辑 `config.json`：

```json
{
  "snowluma": {
    "httpUrl": "http://127.0.0.1:3000",
    "wsUrl": "ws://127.0.0.1:3001",
    "httpToken": "SnowLuma HTTP token",
    "wsToken": "SnowLuma WS token"
  },
  "qq": {
    "ownerQQ": 你的QQ,
    "allow": {
      "private": ["你的QQ"],
      "groups": ["要接入的群号"]
    },
    "allowAllWhenEmpty": false
  },
  "owner": { "agentMode": true }
}
```

- 只有白名单里的群/私聊会收到回复；owner 私聊始终放行。
- `owner.agentMode: true` 表示 owner 私聊走完整 DSH agent（可执行命令/读写文件/发图/管理群）；其他会话是受限鲸鱼娘。
- 不知道 token？打开 SnowLuma 的 OneBot 配置页复制；或看 `SnowLuma/config/onebot_*.json` 的 `httpServers` / `wsServers`。

## 3.5 点歌 / 网站阅读（可选）

- 点歌默认先扫本机音乐库：`%USERPROFILE%\Music\QQMusic`、`%USERPROFILE%\Music`、`%USERPROFILE%\Documents\QQMusic`、`state/media/music`。
- 你自己用 QQ 音乐客户端下载的歌放这些目录即可；也可以写 `music.localDirs` 指定自己的下载目录。
- 本机没有才去 QQ 音乐/网易云找免费音源；VIP/付费/版权受限不会跳过会员限制，会直接说没免费音源。
- 网站阅读用 `read_website`，不需要额外配置。

## 4. 自检

双击：

```
doctor-qq-bridge.cmd
```

应看到：

- Node / DSH SDK profile / patch / 人格工作区 / 余额缓存 通过；
- SnowLuma HTTP / WebSocket 通过；
- QQ MCP 工具数（约 39 个）。

## 5. 启动

双击：

```
start-qq-bridge.cmd
```

窗口保持打开。启动日志会打印：

```
QQ：蓝色大肥鱼（3895207620）
DSH：已就绪 · deepseek-flash
余额：¥xx.xx
控制台：http://127.0.0.1:3210/?token=...
```

令牌也在 `state/bridge-token`。

## 6. 验证

- 私聊 owner QQ 发一句“在吗” → 应回复；
- 群里 @ 机器人 → 应回复；
- 群里发一句“大肥鱼” → 硬唤醒、炸毛；
- 控制台 → 「思考」看推理 + 决策轨迹；
- 控制台 → 「白名单」加/删群和私聊；
- 控制台 → 「扩展」看表情包/头像，点“立即冲浪/立即换”。

## 7. 开机自启（可选）

把 `start-qq-bridge.cmd` 的快捷方式放进：

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
```

或者用任务计划程序，触发器选“登录时”，操作指向 `start-qq-bridge.cmd`。

## 常见问题

**Q：启动报 “缺少 config.json”**
运行 `install.cmd`，或复制 `config.example.json` 为 `config.json`。

**Q：SnowLuma HTTP 401**
`httpToken` 和 `wsToken` 填反了，或者 SnowLuma 改过 token；两个 token 可能不同。

**Q：QQ 上没反应**
1. `doctor-qq-bridge.cmd` 看 SnowLuma 是否通过；
2. 看 `config.json` 白名单；
3. 看 `state/logs/bridge.log` 是否有“唤醒”；
4. 控制台看 DSH 是否 ready。

**Q：owner 私聊没有 agent 能力**
确认 `owner.agentMode: true`、`ownerQQ` 正确，且 `dsh/owner.patch.generated.yml` 存在（重新运行 `install.cmd`）。第一次 owner 私聊会懒启动第二个 DSH 运行时，约 2 秒。

**Q：自动换头像失败**
很多 OneBot 实现没有 `set_qq_avatar`；图片已保存到 `state/avatars`，按日志提示手动设置。

## 更新

```bash
git pull
install.cmd
```

`install.cmd` 会保留你的 `config.json` 与 `state/`，重新生成 patch/人格。

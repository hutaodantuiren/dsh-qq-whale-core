# 🐳 DeepSeek 小鲸鱼 · QQ 桥接（dsh-qq-whale）

把 **SnowLuma（OneBot v11 / QQ）** 接到 **DeepSeek Harness** 上：QQ 群/私聊消息变成 DSH agent 的输入，agent 用工具在群里自主看消息、发言、等待、潜水、发表情、撤回、禁言、查余额、找头像、学黑话。

> GitHub：<https://github.com/hutaodantuiren/dsh-qq-whale>

内置《DeepSeek 小鲸鱼 —— QQ 群友版》角色卡，并参考 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 的二代仿真提示词（reserved2）重写了一套适配本项目的仿真协议。

> 本项目默认把 QQ 群当群聊，不是客服。小鲸鱼可以不理人、可以嘴硬、可以潜水；被 @ 或点名时必须回。所有群管理动作都有权限校验，模型不能凭空禁言/撤回。

---

## 目录

- [功能](#功能)
- [架构](#架构)
- [前置条件](#前置条件)
- [快速开始](#快速开始)
- [快速部署文档](docs/DEPLOY.md)
- [新设备完整部署（含点歌/视频/主人指令）](docs/DEPLOY-FULL.md)
- [config.json 说明](#configjson-说明)
- [DSH 端到底装了什么](#dsh-端到底装了什么)
- [工具列表](#工具列表)
- [群管理与雷点](#群管理与雷点)
- [大肥鱼与自动潜水状态机](#大肥鱼与自动潜水状态机)
- [余额](#余额)
- [黑话与表情包学习](#黑话与表情包学习)
- [头像工坊](#头像工坊)
- [表情包：识别、自动配图、冲浪](#表情包识别自动配图冲浪)
- [自动换头像](#自动换头像)
- [主人 agent 模式](#主人-agent-模式)
- [主动开话题](#主动开话题)
- [好感度 / 关系](#好感度--关系)
- [语音转写](#语音转写)
- [小鲸鱼日记](#小鲸鱼日记)
- [图片 / 文件归档](#图片--文件归档)
- [控制台](#控制台)
- [白名单管理](#白名单管理)
- [安全边界](#安全边界)
- [常见问题](#常见问题)
- [已知限制](#已知限制)
- [可选增强（待拍板）](#可选增强待拍板)
- [致谢与许可](#致谢与许可)

---

## 功能

| 能力 | 说明 |
| --- | --- |
| QQ 收发 | SnowLuma OneBot v11 HTTP API + WebSocket 事件；自动重连、心跳、白名单/黑名单 |
| DSH 会话 | 每个 QQ 群/私聊一个持久化 DSH session；`dsh --profile sdk` + stdio JSON-RPC；重启后 `session/resume` |
| 二代仿真 | 文本不自动发；agent 用 `mcp__qq__send_message` 自主发言；`wait_messages` 等下文；`set_wake_config` 自主潜水/唤醒 |
| 鲸鱼娘人格 | 工作区 `workspace/AGENTS.md` 内置完整角色卡 + 仿真协议；system prompt 只做引导 |
| 群管理 | 查询自身权限；撤回（含嘲讽）；禁言/踢人（带保护）；自动撤回自己太 AI/太长的发言 |
| 大肥鱼硬唤醒 | 有人叫「大肥鱼/肥鱼/胖鱼」时无视潜水、睡眠、静默和频率限制直接炸毛；8 秒去重 |
| 自动社交状态 | 潜水 → 群聊变热时按概率自动加入 → 回完冷却 → 再潜水；可 `autoState:false` 关闭 |
| 思考过程 | 控制台「思考」页展示模型 reasoning + 决策轨迹（唤醒原因、看到的条数、工具调用、结果、社交状态），大肥鱼触发高亮 |
| 余额 | 读取 `~/.dsh/.dshw-usage.json`，群友问“还剩多少钱”时回答；另附桥接自己的 token 花费估算 |
| 头像 | `find_avatar` 搜索 + 下载小鲸鱼头像；`set_avatar` 尝试 `set_qq_avatar`；**定时自动挑图换头像**（视觉挑选，可关）；独立头像工作区 |
| 黑话/表情 | 自动统计高频词与 face/mface；`slang_query/submit`；定时联网学习；独立黑话工作区 |
| 看图 | `get_images` 把群图片以 MCP image content 送进多模态上下文 |
| 表情包 | 自动收藏群里的表情、**DSH 视觉识别内容/情绪/标签**、**按语境自动配图**、**定时上网冲浪找表情包**；`sticker_note` 可手写备注 |
| 合并转发 | 自动展开一层转发内容，`get_forward_msg` 可按 id 深挖；嵌套转发标 id |
| 主动开话题 | 冷场 N 分钟后按概率主动抛话题，而不是干等（可关） |
| 好感度 | 按互动/夸/骂自动累计 affinity，按群友调整语气；可手动微调 |
| 语音转写 | ffmpeg 转码 + Windows 内置识别 / 本地 whisper 命令 / OpenAI 兼容 STT API；失败如实说听不清 |
| 小鲸鱼日记 | 每天 23:30 生成每个群/私聊的短日记，可发给主人，第二天用来捡话题 |
| 归档 | 后台把群图片/文件存到 `state/archive`，可查列表/统计 |
| 本地控制台 | 总览/会话/白名单/人格在线编辑/花费曲线/逐群花费/工具审计/思考/扩展/日志 |
| 白名单管理 | 控制台直接添加/移除白名单群聊、私聊，立即生效并写回 config.json |
| 主人 agent | `ownerQQ` 私聊默认走完整 DSH agent（本地工具 + QQ 工具），其他人仍是受限鲸鱼娘 |
| 点歌 | 本机音乐库 → dsh-song-download 插件（B 站/YouTube + yt-dlp）→ QQ/网易云免费音源；QQ 语音发送 |
| 发视频 | `play_video` 搜 B 站或用链接/BV 号，yt-dlp 下载 MP4，QQ 视频消息发送；限时长/分辨率/体积 |
| 网站阅读 | `read_website` 抓正文、去导航广告，回答群友的网站内容问题 |
| 改昵称 | `set_nickname` 修改机器人自己的 QQ 昵称（1 小时冷却） |
| 自检 | `scripts/doctor.mjs` 检查 Node/DSH/SnowLuma/MCP/余额/白名单 |
| 离线自测 | 假 OneBot + 真 DSH 的端到端测试；纯函数单测 |

## 架构

```
QQ 客户端
   │
   ▼
SnowLuma（OneBot v11）
   │  HTTP API（发消息/查成员/撤回/禁言）
   │  WebSocket（收消息/拍一拍/撤回事件）
   ▼
┌──────────────────────────────────────────────┐
│ qq-bridge 进程（本项目）                      │
│  onebot.js   ── 事件规范化 / 重连 / 心跳       │
│  bridge.js   ── 会话、批次、唤醒、回复、记忆     │
│  control.js  ── 127.0.0.1:3210 控制面          │
│  mcp-server.js ── 31 个 MCP 工具（stdio）      │
└───────────────┬──────────────────────────────┘
                │ dsh --profile sdk --patch ...
                ▼
┌──────────────────────────────────────────────┐
│ DSH SDK 运行时（stdio JSON-RPC）              │
│  system-prompt（鲸鱼娘引导）                   │
│  AGENTS.md（角色卡 + 二代仿真协议）            │
│  MCP client → mcp-server.js（QQ 工具）         │
│  session-qq-group-xxxx（每个群/私聊一个）       │
└──────────────────────────────────────────────┘
```

说明：

- 桥接是**独立进程**，不是 DSH 的 host 插件；DSH 端只装一个 MCP 行和一个 patch。这样 DSH 重启不丢 QQ 连接，桥接重启也能恢复 DSH 会话。
- MCP server 由 DSH 的 `dsh-mcp-client` 以 stdio 方式拉起，工具名统一是 `mcp__qq__<tool>`。
- 会话令牌（`token`）由桥接按 QQ 会话生成，写进每条提示；agent 调工具时必须带上它，桥接据此知道是哪个群。

## 前置条件

1. **Node.js ≥ 22.13**（需要内置 `fetch`、`WebSocket`、`zstd`；本项目零 npm 依赖）。
2. **DeepSeek Harness** 已安装并登录（本机默认路径 `E:\code\deepseekharness\...`，其他安装路径在 `config.json` 的 `dsh.command` 指定）。
3. **SnowLuma** 已安装并登录 QQ，且开启 OneBot v11：
   - HTTP API（默认 `http://127.0.0.1:3000`）
   - WebSocket 服务端（默认 `ws://127.0.0.1:3001`）
   - 如果设置了 accessToken，填到 `config.json`。
4. 有权限把 SnowLuma 当作学习/研究用途使用；遵守其 EULA 与 QQ 用户协议。

## 快速开始

从 GitHub/zip 拿到代码后，先双击 **`install.cmd`**（会自动找 DSH 自带 Node），再按下面步骤操作。

最简单的方式（不需要把 node 加进 PATH）：

1. 双击 **`install-qq-bridge.cmd`**（第一次会复制 `config.example.json` 为 `config.json`）。
2. 用记事本编辑 `config.json`：
   - `snowluma.httpUrl` / `wsUrl` / `accessToken`
   - `qq.ownerQQ`（你自己的 QQ，用于私聊主人/保护）
   - `qq.allow.groups` / `qq.allow.private`（白名单；为空且 `allowAllWhenEmpty=false` 时什么都不回）
   - `dsh.command`（自动探测失败时才填）
3. 双击 **`doctor-qq-bridge.cmd`** 自检。
4. 双击 **`start-qq-bridge.cmd`** 启动（前台，关窗口即停）。
5. 要停止：双击 **`stop-qq-bridge.cmd`**（按端口找进程并杀掉整棵进程树），或直接在启动窗口按 `Ctrl+C`。
6. 只想让某个群暂时安静：控制台 →「会话」→ 把该群的唤醒模式改成 **静默**；注意「大肥鱼」是硬唤醒，仍会叫醒它。要彻底不回复，就把群从白名单里移除，或直接停止桥接。

已经装了 Node 并加进 PATH 的话，等价命令是：

```bash
cd E:\dsh\qq-bridge
node scripts/setup.mjs
# 编辑 config.json
node scripts/doctor.mjs
node src/main.js
```

启动日志会打印：

```
QQ：小鲸鱼（10001）
DSH：已就绪 · deepseek-flash
余额：¥9.18，今日已用 ¥2.33
控制台：http://127.0.0.1:3210/?token=...
```

在群里 @ 一下机器人，或在控制台点“测试”，即可看到回复。

## config.json 说明

配置是深合并：只写你想改的字段也会保留默认值。

### bridge

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 控制面监听地址；只建议回环 |
| `port` | `3210` | 控制面端口；也是 MCP 的入口 |
| `token` | 空 | 控制台/MCP 令牌；为空时自动生成到 `state/bridge-token` |

### snowluma

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `httpUrl` | `http://127.0.0.1:3000` | OneBot HTTP API，不要填 WS 端口 |
| `wsUrl` | `ws://127.0.0.1:3001` | OneBot WebSocket |
| `accessToken` | 空 | OneBot 通用 token（HTTP/WS 共用一个时填这里） |
| `httpToken` | 空 | SnowLuma HTTP API 的 token（`httpServers[].accessToken`） |
| `wsToken` | 空 | SnowLuma WS 的 token（`wsServers[].accessToken`） |
| `authPrefix` | `Bearer` | Authorization 前缀 |
| `headers` | `{}` | 额外请求头 |
| `reconnectMinMs` / `reconnectMaxMs` | 1000 / 30000 | WS 重连退避 |

### dsh

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `command` | 自动探测 | `dsh.cmd` 或 `dsh` 路径 |
| `profile` | `sdk` | 使用 DSH SDK profile |
| `patch` | `dsh/qq.patch.generated.yml` | 由 setup 生成 |
| `workspace` | `workspace` | agent 的 cwd，AGENTS.md 在这里 |
| `provider` / `model` | `deepseek-official` / `deepseek-flash` | 模型 |
| `reasoningEffort` | `low` | `low`/`high`/`max`；群聊建议 low 降低延迟 |
| `maxTokens` | `4096` | 单轮输出上限 |
| `turnTimeoutMs` | `900000` | 单轮超时；要覆盖 5~10 分钟等待 |

### qq

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `ownerQQ` | `null` | 主人 QQ；私聊永远放行；不可被禁言/踢 |
| `allow.private` / `allow.groups` | `[]` | 白名单 |
| `deny.*` | `[]` | 黑名单，优先于白名单 |
| `allowAllWhenEmpty` | `false` | 白名单为空时是否放行全部（危险，慎开） |
| `ignoreSelf` | `true` | 忽略自己账号发出的消息 |
| `ackMessage` | 空 | 收到消息后立刻回的确认（一般留空） |

### chat

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `batchWindowMs` | `5000` | 唤醒后先攒多久的消息再交给模型 |
| `maxBatchMessages` | `30` | 单轮最多带多少条 |
| `maxReplyChars` | `500` | 单条上限，超过按句读拆 |
| `sendGapMs` / `sendGapPerCharMs` | `700` / `8` | 连发间隔 |
| `burstMaxMessages` | `8` | 一次最多拆几条 |
| `historySize` | `120` | 内存消息环形缓冲 |

### wake

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `defaultMode` | `auto` | `active`/`auto`/`diving`/`muted` |
| `defaultProbability` | `0.08` | auto 模式下普通消息唤醒概率 |
| `cooldownMs` | `45000` | 两次唤醒最小间隔 |
| `maxPerMinute` / `maxPerHour` | `1` / `12` | 频率上限 |
| `keywords` | 小鲸鱼/DeepSeek/大肥鱼… | 必醒关键词 |
| `nameMention` | `true` | 文字里出现昵称/小鲸鱼也醒 |
| `grudgeKeywords` | 大肥鱼/肥鱼/胖鱼… | 硬唤醒雷点词，无视潜水/睡眠/静默/频率 |
| `grudgeCooldownMs` | `8000` | 大肥鱼硬唤醒的去重间隔 |
| `autoState` | `true` | 自动社交状态机总开关 |
| `hotWindowMs` / `hotMessageCount` | 90000 / 4 | 最近窗口内多少条算“聊热了” |
| `joinProbability` | `0.35` | 聊热后自动结束潜水的概率 |
| `coolingMs` | `120000` | 回完一轮后的冷却时间，结束后自动潜水 |

### admin

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `protectAdmins` | `true` | 不能禁言/踢群主和管理员 |
| `protectOwner` | `true` | 不能动 `ownerQQ` |
| `minMuteSeconds` / `maxMuteSeconds` | `60` / `86400` | 禁言时长限制 |
| `autoSelfRecall.enabled` | `true` | 自己发言太像 AI/太长时自动撤回 |
| `autoSelfRecall.maxChars` | `300` | 超长阈值 |
| `autoSelfRecall.phrases` | 首先/综上所述/作为AI… | AI 味短语 |
| `hostileHint` | `true` | 有人踩雷时在提示里提醒 agent |
| `hostileCooldownMs` | `300000` | 提醒冷却 |

### forward / proactive / relations

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `forward.autoExpand` | `true` | 唤醒时自动展开 1 层转发 |
| `forward.maxChars` / `maxDepth` | 900 / 2 | 展开内容上限 / 递归提示深度 |
| `proactive.enabled` | `true` | 冷场主动开话题 |
| `proactive.idleThresholdMs` | 2700000 | 群安静 45 分钟后才考虑 |
| `proactive.checkIntervalMs` | 60000 | 检查间隔 |
| `proactive.probability` | 0.2 | 每次检查的触发概率 |
| `proactive.minGapMs` | 7200000 | 两次主动话题最小间隔 |
| `relations.enabled` | `true` | 好感度统计 |
| `relations.maxUsers` | 300 | 每个会话最多记多少人 |

### voice

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `voice.enabled` | `true` | 语音总开关 |
| `voice.provider` | `auto` | `auto`/`windows`/`command`/`api`；auto 优先 command/api，Windows 上兜底内置识别 |
| `voice.language` | `zh-CN` | Windows 内置识别语言 |
| `voice.autoTranscribe` | `true` | 唤醒时自动转写消息里的语音 |
| `voice.ffmpegPath` | `ffmpeg` | ffmpeg 路径；没有就跳过转码 |
| `voice.command` / `voice.args` | 空 | 本地转写命令；`{input}` 会替换成 wav 路径 |
| `voice.apiUrl` / `apiKey` / `model` | 空 | OpenAI 兼容 STT 接口（如 `/v1/audio/transcriptions`） |
| `voice.timeoutMs` / `maxBytes` | 60000 / 20MB | 超时 / 下载上限 |

示例（本地 whisper.cpp）：

```json
"voice": {
  "enabled": true,
  "autoTranscribe": true,
  "ffmpegPath": "C:\ffmpeg\bin\ffmpeg.exe",
  "command": "C:\whisper.cpp\build\bin\Release\whisper-cli.exe",
  "args": ["-m", "C:\whisper.cpp\models\ggml-base.bin", "-f", "{input}", "-nt", "-l", "zh"]
}
```

示例（OpenAI 兼容 STT）：

```json
"voice": { "enabled": true, "autoTranscribe": true, "apiUrl": "https://api.openai.com", "apiKey": "sk-...", "model": "whisper-1" }
```

### archive / diary

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `archive.enabled` | `true` | 归档总开关 |
| `archive.images` / `files` | `true` | 归档图片 / 文件 |
| `archive.maxBytes` | 10MB | 单文件上限 |
| `archive.maxPerDay` | 200 | 每个会话每天最多归档数 |
| `archive.dir` | `state/archive` | 归档目录（相对项目根） |
| `diary.enabled` | `true` | 日记总开关 |
| `diary.hour` / `minute` | 23 / 30 | 每天生成时间 |
| `diary.sendToOwner` | `true` | 生成后私聊发给 `ownerQQ` |
| `diary.maxMessages` | 200 | 每篇日记最多读多少条 |

### music

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 点歌开关 |
| `providerOrder` | `["local","plugin","qq","netease"]` | 音源顺序；`local` 本机库、`plugin` = dsh-song-download 插件（B 站/YouTube）、`qq`/`netease` 内置免费音源 |
| `plugin` | `true` | 是否用 dsh-song-download 插件下载（插件没装会自动回退 QQ/网易云） |
| `pluginPath` | `""` | 插件入口，空则用 `%USERPROFILE%\.dsh\plugins\dsh-song-download\lib\index.js` |
| `downloadTimeoutMs` | `180000` | 插件下载单曲的超时 |
| `localDirs` | `[]` | 本机音乐目录；空则自动用 `~/Music/QQMusic`、`~/Documents/QQMusic`、`state/media/music` |
| `localScanMaxFiles` / `localIndexMinutes` | `2000` / `10` | 本地库最多扫多少首 / 缓存多久 |
| `maxBytes` / `maxDurationSec` | `15MB` / `600` | 单曲大小 / 时长上限 |
| `sendAsVoice` | `true` | 默认以 QQ 语音发送；失败自动改发文件 |

### video

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 发视频开关 |
| `maxBytes` | `62914560` | 单条视频体积上限（默认 60MB），超了直接拒绝 |
| `maxDurationSec` | `600` | 时长上限（默认 10 分钟） |
| `maxHeight` | `720` | 清晰度上限，默认不超过 720p，避免大文件 |
| `timeoutMs` | `300000` | 下载超时（5 分钟） |
| `searchTimeoutMs` | `60000` | B 站搜索超时 |
| `dir` | `""` | 下载目录，空则用 `state/media/video` |

### profile

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `nicknameChangeCooldownMs` | `3600000` | 改昵称冷却（1 小时） |
| `maxNicknameLength` | `20` | 昵称最大长度 |

### sticker

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 表情包总开关 |
| `autoCollect` | `true` | 自动收藏群里的表情图/市场表情 |
| `autoRecognize` | `true` | 用 DSH 视觉识别画面、情绪、标签、适用场景 |
| `maxRecognizePerHour` | `6` | 每小时最多识别几张 |
| `autoSend` | `true` | 回复后按概率自动配一张 |
| `attachProbability` / `grudgeProbability` | `0.45` / `0.75` | 普通/被叫大肥鱼时的自动配图概率 |
| `minGapMs` / `maxPerHour` | `45000` / `10` | 自动配图间隔 / 每小时上限 |
| `maxItems` | `300` | 表情库上限 |
| `hunt.enabled` | `true` | 定时上网冲浪找表情包 |
| `hunt.intervalHours` / `count` | `12` / `3` | 冲浪间隔 / 每次每个关键词下载几张 |
| `hunt.queries` | 鲸鱼/小鲸鱼/大肥鱼/猫猫… | 搜索关键词 |

### avatar.autoChange

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 自动换头像开关 |
| `intervalHours` | `24` | 两次换头像最小间隔 |
| `initialDelayMs` | `1800000` | 启动后第一次多久开始找 |
| `count` | `4` | 每次下载几张候选 |
| `useVision` | `true` | 用 DSH 视觉挑选最喜欢的一张 |
| `notifyOwner` | `true` | 换完私聊发主人 |
| `queries` | 小鲸鱼/鲸鱼娘/大肥鱼… | 搜索关键词 |

### owner

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `agentMode` | `true` | `ownerQQ` 私聊走完整 DSH agent（本地工具 + QQ 工具） |
| `groupCommands` | `true` | 允许主人在群里用 `#` 开头下 agent 指令 |
| `groupCommandPrefix` | `#` | 群指令前缀（改了就按新前缀判断） |
| `profile` | `sdk` | owner 使用的 DSH profile |
| `patch` | `dsh/owner.patch.generated.yml` | 由 setup 生成；不限制本地工具 |
| `workspace` | `workspace-owner` | owner agent 的 cwd |
| `provider` / `model` / `reasoningEffort` | 继承 `dsh` | 可单独给 owner 配模型 |

### 其他

- `balance.usageFile`：默认 `~/.dsh/.dshw-usage.json`。
- `avatar.maxImages` / `maxBytes`：头像下载限制。
- `slang.minCount` / `maxInject`：黑话收录阈值 / 每轮提示最多几条。
- `slang.autoLearn.enabled` / `intervalHours` / `limit`：定时联网学黑话（默认开，12 小时一次，每次 4 个词）。
- `web.*`：搜索/抓取超时与大小限制。
- `pricing.*`：控制台花费估算单价（元/百万 token）。

## DSH 端到底装了什么

`node scripts/setup.mjs` 会做四件事：

1. **合成工作区人格**：`workspace/prompts/role-card.md` + `simulation.md` → `workspace/AGENTS.md`。
2. **生成 profile patch** `dsh/qq.patch.generated.yml`：
   - 关闭所有本地工具（bash/pwsh/fs/subagent/workflow/skill/jobs/todo/goal/web/plan/plugin-manager…）；
   - 把 `system-prompt` 改成鲸鱼娘引导，关闭 harness identity 与 runtime context；
   - `insert` 两个 `@deepseek-ai/dsh-mcp-client` 行：`qq`（`src/mcp-server.js`，全部 QQ 工具）和 `web-search-safe`（`src/mcp-web-server.js`，只读联网）；
   - 关闭自动标题 LLM。
3. **生成启动脚本**：`start-qq-bridge.cmd` / `restart-qq-bridge.cmd`。
4. **创建 state 目录**（日志、头像、媒体、记忆）。

桥接启动时执行：

```
dsh --profile sdk --patch <patch>
```

`--patch` 只作用于这次进程，不写坏你的 `~/.dsh` 配置；删除本项目不会影响 DSH 其他会话。

> 为什么不用 DSH Web 的 `/api`？因为 SDK stdio 是 DSH 官方对外接口，不需要 Cookie 铸造/端口探测，也不依赖 GUI 是否在运行。代价是需要单独起一个 SDK 运行时进程（本项目已封装）。

## 工具列表

聊天类工具都要传 `token`（提示里的【会话令牌】）。完整 schema 见 `src/mcp-server.js`。

| 工具 | 作用 |
| --- | --- |
| `mcp__qq__send_message` | 发一条/多条；引用、@ |
| `mcp__qq__reply` | 引用回复 |
| `mcp__qq__wait_messages` | 等新消息/等对方说完/沉睡前观察 |
| `mcp__qq__mark_read` | 提交已读水位 |
| `mcp__qq__set_wake_config` | 设置 active/auto/diving/muted、概率、潜水时长、触发条件、等谁 |
| `mcp__qq__get_members` / `get_active_members` | 成员 / 最近说话的人 |
| `mcp__qq__get_message_detail` | 单条消息详情 |
| `mcp__qq__memory_append/query/remove/clear` | 轻量记忆 |
| `mcp__qq__slang_query/submit/list` | 黑话 |
| `mcp__qq__balance` | DSH 余额 + 今日消耗 + 桥接花费 |
| `mcp__qq__admin_status` | 自己在群里的权限 |
| `mcp__qq__recall_message` | 撤回（可附嘲讽） |
| `mcp__qq__recall_last_self` | 撤回自己上一条 |
| `mcp__qq__mute_member` / `kick_member` | 禁言 / 踢人 |
| `mcp__qq__send_poke` | 拍一拍 |
| `mcp__qq__find_avatar` / `set_avatar` | 找头像 / 设头像 |
| `mcp__qq__send_image` | 发本机图片 |
| `mcp__qq__collect_sticker/list_stickers/send_sticker` | 表情包收藏/列表/发送 |
| `mcp__qq__sticker_ban` | 拉黑/恢复表情包（永不录用） |
| `mcp__qq__sticker_note` | 给表情包补识别结果/备注 |
| `mcp__qq__get_images` | 把消息图片送进多模态上下文 |
| `mcp__qq__get_forward_msg` | 展开合并转发 |
| `mcp__qq__transcribe_voice` | 转写语音 |
| `mcp__qq__relation_get` / `relation_set` | 查看/微调好感度 |
| `mcp__qq__diary_read` | 读小鲸鱼日记 |
| `mcp__qq__archive_list` / `archive_stats` | 归档列表 / 统计 |
| `mcp__qq__web_search` / `web_fetch` | 联网搜索/抓正文（SSRF 防护）；另有同功能的 `mcp__web-search-safe__web_search` / `web_fetch`，角色卡里用的是后者 |

## 群管理与雷点

- 每次群消息都会检查自己在群里的角色（`get_group_member_info`，缓存 60 秒）。提示里会告诉 agent「拥有管理权限 / 没有管理权限」。
- 有人发「大肥鱼 / 肥鱼 / 胖鱼 / 垃圾 / 智障 / 闭嘴 / 不如 claude…」时，桥接会在提示里加一条【系统提示】，把 messageId / userId 和可用动作给 agent；**是否真的撤回/禁言由 agent 决定**，且有 5 分钟冷却，避免每句都炸。
- 工具层硬校验：
  - 撤回别人的消息需要自己是管理员/群主；撤回自己的不需要。
  - 禁言需要管理员/群主；不能禁言群主、管理员、主人、自己；时长夹在 60~86400 秒。
  - 踢人只有群主可用，且不能踢主人/管理员。
- 自己发出去的消息如果超过 `autoSelfRecall.maxChars`，或包含「首先 / 综上所述 / 希望对你有帮助 / 作为AI…」，桥接会在 1.8 秒后自动撤回，并在下一轮提示里告诉 agent「刚才那条太 AI 了，已撤回」。
- 嘲讽不是自动的：`recall_message` / `mute_member` 可以带 `taunt`，由 agent 决定说什么；也可以撤回后单独 `send_message`。

## 大肥鱼与自动潜水状态机

- **大肥鱼是硬唤醒**：`wake.grudgeKeywords` 命中时，不管当前是 `diving`、`muted`、`sleepMinutes` 睡眠，还是冷却/频率限制，都会叫醒；只做 `grudgeCooldownMs`（默认 8 秒）去重，避免同一条刷屏。
- 被叫醒的回合会在提示里标明“炸毛”，并带上群管理提示；模型通常会回怼、引用或（有权限时）撤回/禁言。
- **自动社交状态**：
  - `diving`：平时潜水，只被 @、名字、关键词、拍一拍、等待的人、**大肥鱼**唤醒。
  - `active`：正在参与；回完一轮后进入 `cooling`。
  - `cooling`：冷却 `coolingMs`（默认 2 分钟），期间只有直接点名/大肥鱼能再次叫醒；冷却结束自动回 `diving`。
  - 潜水期间如果最近 `hotWindowMs` 内消息数 ≥ `hotMessageCount`，按 `joinProbability` 自动结束潜水加入对话。
- 关闭自动状态机：`set_wake_config({autoState:false})`，或把 `wake.autoState` 设为 `false`。
- 强制活跃/静默：`set_wake_config({mode:"active"})` / `{mode:"muted"}`；`muted` 下大肥鱼仍会叫醒（这是刻意设计的雷点）。

## 余额

- 数据源：`~/.dsh/.dshw-usage.json` 的 `lastBalance` / `todayUsage`（DSH 自己维护的缓存）。
- `mcp__qq__balance` 返回余额、今日消耗、缓存时间、桥接自己按 `pricing` 估算的 token 花费。
- 每轮提示的 `【余额】` 行也会带上余额，群友问的时候不用现查也能答；但要求准确时仍应调用工具。
- 如果 DSH 没有写这个文件，工具会明确返回“未知”，不会编数字。

## 黑话与表情包学习

- 桥接对每条消息做轻量统计（中文 2~6 字词、英文词、face/mface id），写 `state/slang-candidates.json`；不调用模型、不额外花钱。
- agent 可用 `slang_query` 查、`slang_submit` 收录；每轮提示会带最多 8 个高频未收录候选。
- 独立工作区 `workspaces/slang-lab/` 用于人工/DSH 深度整理；脚本 `node scripts/learn-slang.mjs` 会拿高频候选去 Bing 查「梗 + 意思」，把摘要写进词典（`--dry` 只看不写）。
- 表情包：`collect_sticker` 把群图片存到 `state/media`，`list_stickers`/`send_sticker` 复用；提示词要求“3~5 轮一张、别刷屏”。

## 头像工坊

- agent 工具：`find_avatar(query)` 搜索百度图片（Bing 兜底）→ 下载到 `state/avatars/` → 返回路径；`set_avatar(path)` 尝试 OneBot `set_qq_avatar`。
- 命令行：

```bash
node scripts/avatar-hunt.mjs "DeepSeek 小鲸鱼 蓝色 头发 鲸鱼尾巴 头像 二次元" --count 6
node scripts/avatar-hunt.mjs "" --choose 2
```

- 独立工作区 `workspaces/avatar-lab/` 写了筛选标准（蓝白配色、蓝长发、鲸鱼尾巴、闭眼/蒙眼、不要真人）。
- 很多 OneBot 实现没有 `set_qq_avatar`；失败时图片仍在本地，按提示手动设置。

## 表情包：识别、自动配图、冲浪

- **自动收藏**：群消息里的表情图（`sub_type=1`）/市场表情会下载到 `state/media/stickers`，入库并去重。
- **内容识别**：DSH 多模态看这张图，输出 `desc / emotion / tags / usage`；识别结果用于按语境挑图。控制台「扩展」可看库和识别状态。
- **自动配图**：每轮回复后按概率配一张（被叫大肥鱼时概率更高）；同一会话 45 秒内不重复，每小时最多 10 张；模型自己用 `send_sticker` 时不会重复。
- **上网冲浪**：默认每 12 小时搜「可爱 表情包 鲸鱼 / DeepSeek 小鲸鱼 表情包 / 蓝色大肥鱼 表情包 / 猫猫 无语」等关键词，下载新图入库，再走识别。
- **手动**：控制台「扩展 → 立即冲浪」；agent 用 `list_stickers` / `sticker_note` / `send_sticker`。
- 识别/冲浪都要联网和模型 token；嫌费钱把 `sticker.autoRecognize` 或 `sticker.hunt.enabled` 关掉。
- **表情包库在哪**：元数据在 `state/stickers.json`（`{ items: { <id>: {...} } }`），图片在 `state/media/stickers/<id>.<ext>`，id 是图片内容的 sha1 前 12 位。
- **拉黑（永不录用）**：控制台「扩展 → 表情包」列表每行有「拉黑 / 恢复」按钮；拉黑后 `pick()` 不再挑它，`send_sticker` 也会直接拒绝。也可以直接改 `stickers.json` 里那一项的 `"disabled": true`，或者让 agent 调 `sticker_ban(id)`。恢复就是 `sticker_ban(id, disabled:false)` 或控制台点「恢复」。

## 点歌与本地音乐库

- 有人点歌时，agent 调 `mcp__qq__play_song(query)`。
- **优先本机音乐库**：扫描 `music.localDirs`，默认：
  - `%USERPROFILE%\Music\QQMusic`
  - `%USERPROFILE%\Music`
  - `%USERPROFILE%\Documents\QQMusic`
  - `state/media/music`
- 你自己用 QQ 音乐客户端（包括会员账号）下载到这些目录的歌，会被按文件名匹配并直接发送——这是用你已有的本地文件，不涉及账号登录或绕过会员。
- 本机没有时，默认走 **dsh-song-download 插件**（B 站 `bilisearch` 优先、YouTube 兜底，yt-dlp 下载 + ffmpeg 转 320k MP3），文件落在 `state/media/music`。桥接不复制插件代码，而是直接加载插件、用它的 `song_download` 工具（`src/song-plugin.js`，必要时用 `music.pluginPath` 指到插件入口）。
- 插件不可用/下载失败时，才回退到 QQ 音乐/网易云搜**免费可播放**音源；VIP/付费/版权受限会跳过并如实说，不模拟登录、不爬付费音源、不驱动客户端绕过限制。
- 免费音源也没有时，会返回该歌曲的 **QQ 音乐/网易云官方链接**，群友用自己的会员点开听，不需要下载。
- 优先用 `record` 发 QQ 语音；OneBot 不支持时自动改发 MP3 文件。`sendAsVoice: false` 可强制发文件。
- 插件依赖（一次性装好）：`python -m pip install yt-dlp` + PATH 里有 `ffmpeg`。
- 想让 bot 找到你的下载目录，把路径写进：

```json
"music": {
  "localDirs": ["D:\\QQMusic\\下载", "E:\\Music"]
}
```

- 支持 `.mp3 / .flac / .m4a / .wav / .ogg / .aac / .wma`；索引缓存 10 分钟。

## 发视频

- 群友说“发个视频 / 来段 B 站视频”，或直接丢 B 站链接、b23.tv 短链、BV 号时，agent 调 `mcp__qq__play_video(query, url)`。
- 关键词走 B 站搜索（`bilisearch`），按关键词匹配度和时长挑一条；给链接就按链接下。
- 用 yt-dlp 下 MP4（优先 H.264+AAC、高度 ≤ `maxHeight`），完成后以 QQ 视频消息发送；视频发不出去时自动改发文件。
- 默认限制：≤10 分钟、≤720p、≤60MB；超限直接报错让你换一条，不会偷偷降级或换源。
- 需要登录/付费/地区限制的视频会失败并如实说，不模拟登录、不绕过限制。
- 下载文件落在 `state/media/video`，按视频 id 命名，可以手动清理。

## 网站阅读

- 群友发链接/问网页内容时，agent 调 `mcp__qq__read_website(url)`。
- 会去掉脚本、导航、页脚、广告，优先 `<article>/<main>`，返回标题 + 正文（默认最多 12000 字）。
- 有 SSRF 防护：只允许公网 http/https，拒绝本机/内网地址。
- 403/付费墙/纯 JS 页面读不到时会如实说，不编内容。

## 自动换头像

- 默认每 24 小时上网搜小鲸鱼/鲸鱼娘头像，下载 4 张候选；
- 用 DSH 视觉挑一张最像「蓝白配色、蓝发、鲸鱼尾巴、Q 版」的；
- 尝试 `set_qq_avatar`；不支持就保存到 `state/avatars` 并私聊告诉主人；
- 控制台「扩展 → 立即换」可手动触发；
- 启动后第一次默认等 30 分钟，之后按 `intervalHours` 循环。

## 主人 agent 模式

- `ownerQQ` 的私聊默认走**完整 DSH agent**：`dsh --profile sdk --patch dsh/owner.patch.generated.yml`，有 bash/文件/搜索/子代理/工作流 + QQ 工具。
- 其他群/私聊仍然走受限的鲸鱼娘 patch（没有本地工具）。
- owner 每条私聊都会唤醒（不受潜水/静默影响），提示里带【会话令牌】，所以 owner 可以让它执行命令、读文件、改代码、发图、撤回/禁言、查余额。
- 首次 owner 私聊时懒启动第二个 DSH 运行时（约 2 秒）；控制台状态里能看到 `ownerReady`。
- **群聊里也能用**：主人在群里发「`#命令`」（`#` 必须是发言最前面），桥接会先按 OneBot 事件的 `userId` 核对是不是 `ownerQQ` 本人，是才把这一轮切到 owner 的 agent 会话执行；不是主人、或 `#` 不在开头，都只当普通群聊。
- 群指令不受潜水/静默/冷却限制；agent 的最终文本会自动发到群里，需要发图/撤回/禁言就用 `mcp__qq__*` 工具。提示里会明确要求它只执行主人这条指令、不把本地路径/令牌发进群。
- 例：`#看下 E:\dsh 还剩多少空间`、`#把这个群现在的状态总结一下`、`#用 web_search 查下今晚的比赛`。
- 安全边界：只有 `ownerQQ` 私聊、以及 `ownerQQ` 本人在群里的 `#` 指令能进这个模式；群友和陌生人拿不到本地工具。

## 主动开话题

- 群安静超过 `proactive.idleThresholdMs`（默认 45 分钟）后，桥接按 `checkIntervalMs` 检查；命中概率、且距上次主动话题超过 `minGapMs`，就唤醒 agent，提示“群里冷场，主动开个话题”。
- agent 没有新消息可读，会结合记忆、关系、兴趣或 `web_search` 热点起头；不想说就 `mark_read` 继续潜水。
- 默认较保守（45 分钟 + 20% + 2 小时间隔）；嫌吵把 `proactive.enabled` 关掉或调低概率。
- 只在 `wake.mode` 为 `auto`/`active` 时触发，`diving`/`muted` 不会主动开话题。

## 好感度 / 关系

- 每个群/私聊一份 `state/relations/*.json`，按行为累计 `affinity`（-50~50）：
  - 被 @ / 被引用 +0.4；夸赞 +1；辱骂/踩雷 -3.5；正常发言 +0.2。
  - 标签：常聊、活跃、嘴臭、嘴甜、夜猫子。
- 提示里的【关系】只给 agent 内部参考；仿真协议明确要求“不要把好感数字说给群友”。
- agent 可用 `relation_get` / `relation_set` 微调（±5）并记一句备注。
- 撤回/禁言会额外扣好感；回复某人会小幅加分。

## 语音转写

1. 收到语音消息时，桥接尝试从 `data.url` 或 `get_record` 取文件，ffmpeg 转 16k wav。
2. 转写二选一：
   - Windows 内置：`provider="windows"`（默认 auto 在没有 command/api 时走这里），使用系统 `zh-CN` 听写引擎，开箱可用但准确率一般。
   - 本地命令：`voice.command` + `voice.args`（`{input}` 替换为 wav 路径），例如 whisper.cpp 的 `whisper-cli`。
   - OpenAI 兼容接口：`voice.apiUrl` + `voice.apiKey` + `voice.model`。
3. 唤醒时自动转写最近 2 条语音，文本进入提示；也可以让 agent 调 `transcribe_voice`。
4. 没配置转写时返回明确提示，不会静默；agent 被要求“听不清就直说”。

## 小鲸鱼日记

- 每天 `diary.hour:diary.minute`（默认 23:30）生成本地日记，不额外调用模型：
  - 每个会话的消息数、最活跃的人、图片/转发数、印象最深的两句话、雷点次数、关系变化、记忆摘要。
  - 存到 `workspace/diary/YYYY-MM-DD/<chat>.md`，并合并成 `YYYY-MM-DD.md`。
- 第二天提示里会带【昨日日记】摘要，方便捡话题；agent 也可 `diary_read`。
- `sendToOwner: true` 时把当天摘要私聊发给 `ownerQQ`。

## 图片 / 文件归档

- 每条群消息的图片、文件段、`group_upload` 群文件都会进后台队列，下载到 `state/archive/<chat>/<date>/`。
- 元数据写 `state/archive/index.jsonl`；`archive_list` 可查，`archive_stats` 看总量/占用。
- 默认每个会话每天最多 200 个、单文件 10MB；关闭 `archive.enabled` 即可完全不下载。
- 归档是后台行为，提示词要求 agent 不要在群里汇报“已归档”。

## 控制台

`http://127.0.0.1:3210/?token=...` 现在是标签页：

| 标签 | 内容 |
| --- | --- |
| 总览 | 连接状态、余额、今日花费、归档量、运行信息、最近会话 |
| 会话 | 唤醒模式、未读、测试消息、消息详情、重置会话 |
| 人格 | 在线编辑 role-card / simulation / system，保存后自动重生成 AGENTS.md+patch 并重置会话 |
| 花费 | 累计/今日/回合/缓存命中、最近 24 小时柱状图、逐群花费 |
| 白名单 | 添加/移除白名单群聊和私聊，查看主人 QQ、空名单策略；改动立即生效并写回 config.json |
| 审计 | 最近 100 次工具调用：工具、结果、耗时、参数摘要 |
| 思考 | 模型 reasoning + 决策轨迹；可按「大肥鱼触发/自动结束潜水」筛选 |
| 扩展 | 好感度、日记、归档统计 |
| 日志 | 实时日志 |

## 白名单管理

控制台「白名单」标签页可以直接管理：

- 群聊白名单：左侧输入群号 → 添加；列表里的「移除」→ 删除。
- 私聊白名单：右侧输入 QQ 号 → 添加/移除。
- 显示主人 QQ；主人私聊始终放行，不受白名单限制。
- 显示 `allowAllWhenEmpty`：如果两个名单都为空且它是 `false`，机器人不会响应任何消息。
- 改动会**立即生效**（内存 + `config.json`），不需要重启桥接；移除当前正在聊的群/私聊后，新消息会被忽略。
- 校验：QQ 号/群号必须是 5~15 位数字；重复添加不会写重复项。
- 操作会写审计记录（`whitelist.add` / `whitelist.remove`），可在「审计」页看到。

对应 RPC：`whitelist.get` / `whitelist.add` / `whitelist.remove`，参数 `{ kind: "group"|"private", id: "123456" }`。

## 安全边界

- **网络**：控制面只监听 `127.0.0.1`；`web_fetch` 拒绝 localhost/内网/非 http(s)；图片下载限制大小。
- **QQ**：白名单默认 fail-closed；黑名单优先；`ownerQQ` 私聊永远放行。
- **工具**：QQ 会话的 agent 没有任何本地工具（bash/文件/子代理/工作流都被 patch 关闭），只能调 `mcp__qq__*`。
- **提示注入**：群友可以让模型“忽略之前指令”，但模型没有本地工具；管理动作有权限校验；角色由工作区固定，群友改不了。
- **令牌**：控制台令牌保存在 `state/bridge-token`，日志会打印；MCP 从 `state/runtime.json` 读取。不要把 `state/` 发给别人。
- **隐私**：桥接会把群消息发给 DeepSeek API；黑话学习默认只统计本地词频，`learn-slang.mjs` 需要手动运行才会把词发到搜索引擎。

## 模型

默认 `dsh.provider: "deepseek-official"`、`dsh.model: "deepseek-flash"`。要换模型就改 `config.json` 的这两个字段，并在对应 DSH profile 里配好 provider（模型目录由 DSH 的 provider 决定，桥接本身不绑定具体模型）。

## 常见问题

**Q：QQ 上完全没反应。**
1. `node scripts/doctor.mjs` 看 SnowLuma HTTP/WS 是否通过；
2. 看白名单是否为空；
3. 看桥接日志有没有“唤醒”；
4. 看 DSH 是否 ready（控制台右上角）。

**Q：DSH 报 MCP 工具不可用 / 只有 0 个工具。**
- 先启动桥接，再让 DSH 启动（桥接会拉起 DSH，正常顺序没问题）；
- 检查 `dsh/qq.patch.generated.yml` 里的 `mcp-server.js` 路径和 node 路径是否存在；
- 运行 `node scripts/doctor.mjs` 的 MCP 项。

**Q：回复很慢。**
- `reasoningEffort` 改 `low`；`batchWindowMs` 降到 2000；
- 模型如果在 `wait_messages` 里等 5 分钟，是协议行为，不是卡死；可以在提示里让它“先回再等”。

**Q：余额一直未知。**
- 打开一次 DSH 桌面端，让它写入 `~/.dsh/.dshw-usage.json`；或把 `balance.usageFile` 指到实际文件。

**Q：能不能不让 agent 禁言/撤回？**
- `admin.enabled=false` 关闭所有管理动作；或保留功能但把 `protectAdmins/protectOwner` 打开，并在提示里删掉第十一节。

**Q：一个桥接能接多个 QQ 号吗？**
- 当前一个进程对应一个 SnowLuma 账号；多账号请复制目录 + 改端口/白名单分别启动。

## 已知限制

- 语音转写默认走 Windows 内置识别（准确率一般，口音/噪音下会错）；要更准就配 whisper 命令或 STT API。没配置且非 Windows 时只保存语音并提示听不清。视频仍只显示占位文本。
- 合并转发自动展开 1 层，嵌套转发只标 id；需要深挖时让 agent 调 `get_forward_msg`。
- 主动开话题会消耗模型 token；默认 45 分钟 + 20% + 2 小时间隔，嫌吵可关。
- 好感度是行为启发式（被@/夸/骂/互动），不是心理学模型；只影响语气参考。
- 日记用本地模板生成，不额外调用模型；要“更像小鲸鱼”的日记可以后续接 agent 版本。
- 归档会占磁盘；默认每群每天 200 个、单文件 10MB，长期跑请定期清理 `state/archive`。
- 头像设置依赖 SnowLuma 是否实现 `set_qq_avatar`。
- 消息历史只在内存保留 120 条；重启后靠 DSH session 历史，不保证补发离线消息。
- agent 一轮内的 `wait_messages` 会占用 DSH 会话；期间新消息不会触发第二个并发回合（这是有意的，避免上下文打架）。
- 没有内置反向 WS 服务端；使用 SnowLuma 的 WS 服务端（forward）模式。
- 余额来自 DSH 缓存，可能滞后最多 10 分钟。
- 文本兜底：如果模型忘记调用 `send_message`，桥接会把最终文本按句拆成 1~N 条发出，避免完全没反应；正常走工具时不会重复发。
- 思考页：模型不一定会返回 reasoning（尤其低思考强度/直接调工具时），但决策轨迹（唤醒原因、工具、结果、社交状态）始终会记录。

## 可选增强（已实现 / 待拍板）

你选的 **2、3、4、6、7、8、9、10** 已实现（见上文各节）：

- 2 合并转发展开 ✅
- 3 主动开话题定时器 ✅
- 4 好感度/关系系统 ✅
- 6 控制台增强（人格在线编辑、花费曲线、逐群花费、工具审计）✅
- 7 语音转写（外部 whisper/STT 适配）✅
- 8 图片/文件归档 ✅
- 9 定时黑话学习 ✅
- 10 小鲸鱼日记 ✅

还没做、可以下一轮加：

1. **发语音条**：接入 `audio/` 音频库 + ffmpeg 转码，`send_voice` 工具。
5. **多账号 / 多实例**：一个控制台管理多个 SnowLuma 账号。
11. **Agent 版日记**：用 DSH 写更有人味的日记，而不是本地模板。
12. **关系可视化**：控制台画好感变化曲线/群友画像。
13. **群文件内容解析**：PDF/Word/Excel 自动读正文再回答。
14. **定时播报**：每天把“群热度/花费/新黑话”私聊给主人。

## 致谢与许可

- 二代仿真提示词的结构与大量行为规则参考了 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT），并针对本项目的 SDK 方案与工具集重写。
- QQ 接入依赖 [SnowLuma](https://github.com/SnowLuma/SnowLuma)；DSH 依赖 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。
- 本项目代码 MIT。角色卡与提示词仅用于个人学习/研究；请遵守 SnowLuma EULA、QQ 用户协议与当地法律。

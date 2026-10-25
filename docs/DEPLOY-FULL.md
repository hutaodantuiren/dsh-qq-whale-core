# 新设备完整部署（含点歌 / 视频 / 主人指令）

这份文档面向「换一台 Windows 电脑，把这套 QQ 桥接跑起来」。只想最快跑通看 [DEPLOY.md](DEPLOY.md)；想连点歌、发视频、主人 `#` 指令和 Gemini 一起用，按下面来。

## 0. 前置

| 需要 | 说明 |
| --- | --- |
| Windows 10/11 x64 | 脚本都是 cmd/PowerShell |
| DeepSeek Harness 桌面版 | 已安装并登录，`dsh.cmd` 可用 |
| SnowLuma | 注入 QQ，开 OneBot v11：HTTP 3000 / WS 3001 |
| Python 3.10+ | `python` 在 PATH；点歌/视频要用 |
| yt-dlp、ffmpeg | `python -m pip install yt-dlp`，ffmpeg 放 PATH（或 `pip install imageio-ffmpeg`） |

## 1. 拿代码

```bash
git clone https://github.com/hutaodantuiren/dsh-qq-whale-deploy.git
cd dsh-qq-whale-deploy
```

私有仓库就用带 token 的地址或 `gh auth login` 后再 clone。也可以直接下 zip 解压，效果一样。

## 2. 一键安装

双击 `install.cmd`。它会：

- 找 DSH 自带的 node，生成 `config.json`（首次）、`workspace/`、`dsh/qq.patch.generated.yml`、`dsh/owner.patch.generated.yml`
- 生成 `start-qq-bridge.cmd` / `restart-qq-bridge.cmd` / `doctor-qq-bridge.cmd`

装完先别急着启动，下一步填配置。

## 3. 填 config.json

最少改这几处（`config.example.json` 每项都有注释）：

```json
{
  "snowluma": {
    "httpUrl": "http://127.0.0.1:3000",
    "wsUrl": "ws://127.0.0.1:3001",
    "httpToken": "SnowLuma 的 httpServers[].accessToken",
    "wsToken": "SnowLuma 的 wsServers[].accessToken"
  },
  "qq": {
    "ownerQQ": 你的QQ号,
    "allow": { "private": ["你的QQ号"], "groups": ["要接入的群号"] }
  }
}
```

`config.json` 已被 `.gitignore` 排除，不会上传；换设备要重新填一次。

## 4. 点歌：装 dsh-song-download 插件

点歌默认顺序是「本机音乐库 → 插件（B 站/YouTube）→ QQ 音乐/网易云」。插件没装也能用，但会少掉 B 站源。

```bash
dsh plugin --profile desktop add github:Raywh/dsh-song-download
```

装完重启 DSH 桌面版生效。插件依赖：`python -m pip install yt-dlp` + `ffmpeg`。

> 如果 GitHub 直连不通（国内常见），可以按 README「点歌与本地音乐库」里的离线方式：把插件目录放到 `%USERPROFILE%\.dsh\plugins\dsh-song-download`，在 `profiles/desktop/package.json` 里加 `link:` 依赖并把它加进 `dsh.profile.bundles`。

## 5. 启动顺序

1. **QQ** 登录机器人账号
2. **SnowLuma** 注入完成（或双击 `launcher.bat`），等 OneBot 3000/3001 起来
3. **桥接**：双击 `start-qq-bridge.cmd`（或安装时生成的桌面快捷方式）
4. 控制台：`http://127.0.0.1:3210/?token=…`（启动日志会打印）

桥接先起、SnowLuma 后起也没关系，重连时会自动补拉登录信息。

## 6. 自检

```bash
node scripts/doctor.mjs
```

看 SnowLuma HTTP/WS、DSH、余额、白名单是否都通过；控制台右上角应显示「QQ：昵称（QQ号）/ DSH 已就绪」。

## 7. 这一版新增的功能

| 功能 | 入口 | 说明 |
| --- | --- | --- |
| 点歌 | `play_song` | 本机库 → dsh-song-download 插件（B 站/YouTube + yt-dlp）→ QQ/网易云兜底；发 QQ 语音 |
| 发视频 | `play_video` | B 站搜索或链接/BV 号，下载 MP4 发 QQ 视频；默认 ≤10 分钟 / 720p / 60MB |
| 主人群指令 | 群里 owner 发 `#…` | 校验发言者 QQ 号 + `#` 必须在最前面；这一轮切到 owner 的完整 agent |
| 表情包拉黑 | 控制台「扩展 → 表情包」 | 每行「拉黑/恢复」；拉黑后自动配图和 `send_sticker` 都不再用它；也可 `sticker_ban(id)` |
| 桌面控制台 | `open-console.cmd` | 一键检测端口 → 没起就拉桥接 → 打开带 token 的控制台 |

## 8. 常见问题

- **控制台显示 QQ 未登录**：SnowLuma 没挂上。先确认 QQ 已登录、launcher 窗口没关；桥接重连会自动补。
- **回得很慢 / 完全没回**：先看是不是模型侧（反代健康分、节点地区、429）；桥接日志里 `回合结束原因：error` 就是模型/工具链失败。
- **点歌失败**：插件没装、`yt-dlp` 不在 Python 里、或 B 站 412；日志会写原因。
- **视频发不出**：超过 `video.maxBytes` / `maxDurationSec`，或源站限制；调大限制或换一条。
- **owner `#` 指令没反应**：确认 `owner.groupCommands` 没关、发的是 owner 本人的号、`#` 在最前面；日志应有「唤醒：主人指令（#）」。

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Write-Host '🐳 DeepSeek 小鲸鱼 QQ 桥接 · 安装' -ForegroundColor Cyan
Write-Host "项目目录：$Root"

$Candidates = @(
  $env:DSH_NODE,
  (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'),
  'E:\code\deepseekharness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
)
$Node = $Candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $Node) {
  $Cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($Cmd) { $Node = $Cmd.Source }
}
if (-not $Node) {
  Write-Host '未找到 Node.js（需要 >= 22.13）。' -ForegroundColor Red
  Write-Host '请安装 Node.js，或把 DSH 自带的 node.exe 路径设置到 DSH_NODE 环境变量后重试。'
  exit 1
}
Write-Host "使用 Node：$Node"
& $Node (Join-Path $Root 'scripts\setup.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ''
Write-Host '下一步：编辑 config.json（SnowLuma 地址/令牌、ownerQQ、白名单），' -ForegroundColor Green
Write-Host '然后双击 doctor-qq-bridge.cmd 自检，再双击 start-qq-bridge.cmd 启动。'

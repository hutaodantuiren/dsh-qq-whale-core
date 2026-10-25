$ErrorActionPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
$Port = 3210
try {
  $Config = Get-Content (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json
  if ($Config.bridge.port) { $Port = [int]$Config.bridge.port }
} catch { }

$Conn = Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object -First 1
if (-not $Conn) {
  Write-Host "QQ bridge is not running (port $Port is not listening)." -ForegroundColor Yellow
  exit 0
}
$ProcessId = $Conn.OwningProcess
$Proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
Write-Host "Stopping QQ bridge: PID $ProcessId $($Proc.ProcessName) (port $Port)" -ForegroundColor Cyan
& taskkill.exe /PID $ProcessId /T /F | Out-Null
Start-Sleep -Milliseconds 800
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  Write-Host 'Port is still listening; run this again or reboot.' -ForegroundColor Red
  exit 1
}
Write-Host 'Stopped QQ bridge. SnowLuma / DSH are unaffected.' -ForegroundColor Green

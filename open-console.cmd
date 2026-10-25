@echo off
rem One-click launcher for the QQ bridge console (DeepSeek 小鲸鱼).
rem Starts the bridge if it is not running, then opens the console page in the default browser.
setlocal
chcp 65001 >nul
set "ROOT=E:\dsh\qq-bridge"
set "NODE=E:\code\deepseekharness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
set "URL=http://127.0.0.1:3210/"
set "TOKEN="

if exist "%ROOT%\state\bridge-token" set /p TOKEN=<"%ROOT%\state\bridge-token"
if defined TOKEN set "URL=http://127.0.0.1:3210/?token=%TOKEN%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',3210);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%NODE%' -ArgumentList 'src/main.js' -WorkingDirectory '%ROOT%' -WindowStyle Hidden"
  timeout /t 8 /nobreak >nul
)

start "" "%URL%"
endlocal
exit /b 0

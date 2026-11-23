@echo off
chcp 65001 >nul
title NoteBridge 音桥 - 一键启动
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 20 或更高版本后重试。
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 npm，请先检查 Node.js 安装是否完整。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [提示] 首次运行，正在安装依赖，请稍候...
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络连接或 npm 配置。
    pause
    exit /b 1
  )
)

echo ========================================
echo   NoteBridge（音桥）正在启动...
echo   启动后将自动在默认浏览器打开页面：
echo   http://localhost:5173
echo   （保持本窗口开启即可，关闭窗口将停止服务）
echo ========================================
echo.

call npm run dev -- --open
if errorlevel 1 (
  echo.
  echo [错误] 启动失败，可能是 5173 端口已被占用。请关闭占用端口的程序后重试。
  pause
  exit /b 1
)

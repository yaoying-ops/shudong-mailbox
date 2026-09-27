@echo off
title 树洞信箱 · 一键启动
setlocal

rem ===== 基础参数（可按需修改）=====
set "PORT=3000"
set "AUTO_SEED=0"
set "DB_PATH=%LOCALAPPDATA%\shudong.sqlite"
set "MOUNT_PREFIX=/shudong"

rem ===== 中心端登录口令（可选）=====
rem 不设 → 演示态，打开 http://localhost:%PORT%/center 直接进；设了 → 每次打开要求输口令。
rem 本地演示口令（已在 README 中公开，供下载者直接体验双角色）：
rem    管理员 admin2026   —— 全权限：看板 / 知识库 / Key 管理 / 清空数据
rem    咨询师 counselor2026 —— 只读看板 + 干预登记
rem 想换成自己的口令，直接改下面两行的值即可（改完必须重开窗口，服务只在启动时读一次）。
rem 公网部署务必换成 20 位以上随机强口令：admin2026 / counselor2026 是演示用值，fail-closed 拦不住。
set "ADMIN_PASS=admin2026"
set "COUNSELOR_PASS=counselor2026"

rem ===== 定位：本脚本与服务目录 server 同级，换机器无需改路径 =====
set "WEB_DIR=%~dp0"
set "SERVER_DIR=%WEB_DIR%server"

rem ===== 找 Node：优先用 PATH 里的，其次常见安装位置 =====
where node >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%p in ('where node') do if not defined NODE_EXE set "NODE_EXE=%%p"
  goto :found_node
)
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
  goto :found_node
)
if exist "%LOCALAPPDATA%\Programs\NodeJS\node.exe" (
  set "NODE_EXE=%LOCALAPPDATA%\Programs\NodeJS\node.exe"
  goto :found_node
)
echo [错误] 未找到 Node.js。请先安装 Node.js 18 – 22 版本（推荐 20 LTS），并确认 node 已在 PATH 中。
goto :end

:found_node
for %%i in ("%NODE_EXE%") do set "NODE_DIR=%%~dpi"
if exist "%NODE_DIR%npm.cmd" (set "NPM_EXE=%NODE_DIR%npm.cmd") else (
  for /f "delims=" %%p in ('where npm') do if not defined NPM_EXE set "NPM_EXE=%%p"
)
if not defined NPM_EXE set "NPM_EXE=npm.cmd"
if not exist "%SERVER_DIR%\server.js" (
  echo [错误] 未找到 %SERVER_DIR%\server.js
  echo 请确认 server 目录与本脚本位于同一层目录。
  goto :end
)

rem ===== 依赖缺失时自动安装（首次运行会慢一点，属正常）=====
if not exist "%SERVER_DIR%\node_modules" goto :install_deps

rem ===== 原生模块与当前 Node 版本匹配自检 =====
rem 复制文件夹或更换 Node 版本后，better-sqlite3 的二进制可能不匹配
rem（典型报错 ERR_DLOPEN_FAILED / NODE_MODULE_VERSION），此处自动重装修复。
cd /d "%SERVER_DIR%"
if errorlevel 1 (
  echo [错误] 无法进入服务目录：%SERVER_DIR%
  goto :end
)
"%NODE_EXE%" -e "new (require('better-sqlite3'))(':memory:')" >nul 2>nul
if not errorlevel 1 goto :deps_ok
echo [提示] 检测到依赖与当前 Node.js 版本不匹配，正在自动修复（约 1 分钟）...
call "%NPM_EXE%" rebuild better-sqlite3 --no-audit --no-fund
if not errorlevel 1 goto :deps_ok
echo [提示] 自动修复未成功，转为完整重装依赖...

:install_deps
cd /d "%SERVER_DIR%"
if errorlevel 1 (
  echo [错误] 无法进入服务目录：%SERVER_DIR%
  goto :end
)
echo 正在安装依赖（首次运行或更换 Node 版本后，请稍候）...
call "%NPM_EXE%" install --no-audit --no-fund
if errorlevel 1 (
  echo [错误] 依赖安装失败，请稍后在正常网络下重试。
  goto :end
)

:deps_ok

echo ============================================
echo   树洞信箱已启动
echo   学生端： http://localhost:%PORT%/
echo   中心端： http://localhost:%PORT%/center
echo   关闭本窗口或按 Ctrl+C 即可停止服务
echo ============================================

"%NODE_EXE%" server.js

:end
pause

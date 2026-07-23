@echo off
REM start.cmd — find node and launch the Google Multi-Account MCP server (Windows)
REM
REM Windows counterpart to start.sh. Same reason it exists: Claude Desktop is
REM launched from Explorer, not a shell, so a node installed by nvm-windows,
REM volta, or fnm is not on the inherited PATH. Registering "node" directly in
REM claude_desktop_config.json works only if node came from the official MSI.
REM
REM The desktop config calls:
REM   "command": "cmd", "args": ["/c", "C:\\Users\\<you>\\.google-multi-mcp\\start.cmd"]
REM cmd.exe is a fixed system path, so that entry always resolves.

setlocal

set "ROOT=%~dp0"
set "SERVER=%ROOT%server\index.js"

REM Read this outside any parenthesized block. The close-paren character inside
REM the variable name terminates an if-block early and breaks batch parsing.
set "PF86=%ProgramFiles(x86)%"

REM 1. node already on PATH (official MSI install, or an inherited shell)
where node >nul 2>nul
if %ERRORLEVEL% equ 0 goto run

REM 2. Volta
if exist "%USERPROFILE%\.volta\bin\node.exe" (
  set "PATH=%USERPROFILE%\.volta\bin;%PATH%"
  goto run
)

REM 3. nvm-windows — NVM_SYMLINK points at the active version
if defined NVM_SYMLINK (
  if exist "%NVM_SYMLINK%\node.exe" (
    set "PATH=%NVM_SYMLINK%;%PATH%"
    goto run
  )
)

REM 4. fnm
if exist "%LOCALAPPDATA%\fnm\fnm.exe" (
  set "PATH=%LOCALAPPDATA%\fnm;%PATH%"
  goto run
)

REM 5. Standard install locations
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
  goto run
)
if exist "%PF86%\nodejs\node.exe" (
  set "PATH=%PF86%\nodejs;%PATH%"
  goto run
)

echo ERROR: node not found after checking PATH, volta, nvm-windows, fnm, and Program Files. 1>&2
echo Install Node.js 18+ from https://nodejs.org and restart Claude. 1>&2
exit /b 1

:run
REM Warn on old Node but still try — the server may work fine.
for /f "tokens=1 delims=." %%v in ('node -v') do set "NODE_MAJOR=%%v"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if %NODE_MAJOR% LSS 18 (
  echo WARNING: Node %NODE_MAJOR% detected. Version 18 or newer is required. 1>&2
)

node "%SERVER%"

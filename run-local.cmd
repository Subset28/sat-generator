@echo off
setlocal
set "ROOT=%~dp0"
set "NODE="

if exist "%LOCALAPPDATA%\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
  set "NODE=%LOCALAPPDATA%\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
) else if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
  set "NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
) else if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODE=%ProgramFiles%\nodejs\node.exe"
) else if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
  set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
)

if not defined NODE (
  echo Node.js was not found. Install Node.js or keep the Codex runtime available.
  exit /b 1
)

"%NODE%" "%ROOT%scripts\run-local.cjs" %*

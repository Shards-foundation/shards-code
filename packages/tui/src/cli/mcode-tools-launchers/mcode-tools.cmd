@echo off
setlocal
if not defined __MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE (
  echo Shards Code mcode-tools runtime is unavailable. Restart Shards Code. 1>&2
  exit /b 1
)
"%__MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE%" "%~dp0..\mcode-tools.js" %*
exit /b %errorlevel%

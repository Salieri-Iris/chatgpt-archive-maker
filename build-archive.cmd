@echo off
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"

if not "%~1"=="" (
  node "%SCRIPT_DIR%bin\chatgpt-archive-maker.mjs" %*
  exit /b %ERRORLEVEL%
)

set "DEFAULT_INPUT="
if exist "%SCRIPT_DIR%..\OpenAI-export" set "DEFAULT_INPUT=%SCRIPT_DIR%..\OpenAI-export"
if exist "%SCRIPT_DIR%..\OpenAI-export.zip" set "DEFAULT_INPUT=%SCRIPT_DIR%..\OpenAI-export.zip"

if "%DEFAULT_INPUT%"=="" (
  echo No arguments were provided, and no sibling OpenAI-export or OpenAI-export.zip was found.
  echo Usage:
  echo   build-archive.cmd --input ^<OpenAI export zip or directory^> --output ^<output directory^> --force
  exit /b 2
)

set "DEFAULT_OUTPUT=%SCRIPT_DIR%..\ChatGPT-archive-generated"
echo Input: %DEFAULT_INPUT%
echo Output: %DEFAULT_OUTPUT%
node "%SCRIPT_DIR%bin\chatgpt-archive-maker.mjs" --input "%DEFAULT_INPUT%" --output "%DEFAULT_OUTPUT%" --force
exit /b %ERRORLEVEL%

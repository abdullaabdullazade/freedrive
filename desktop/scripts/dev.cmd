@echo off
call "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
if errorlevel 1 (
  echo ERROR: Visual Studio Build Tools not found.
  echo Install with: winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  exit /b 1
)
cd /d "%~dp0.."
if /I "%~1"=="build" (
  npm run build:exe:clean
) else (
  npm run tauri dev
)

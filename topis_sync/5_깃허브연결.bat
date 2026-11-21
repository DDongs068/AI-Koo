@echo off
cd /d "%~dp0"
where git >nul 2>nul
if errorlevel 1 (
  echo git 프로그램이 없습니다. https://git-scm.com/download/win 에서 받아 기본 설정 그대로 설치한 뒤 이 파일을 다시 실행하세요.
  pause
  exit /b
)
if exist "AI-Koo\.git" (
  echo 이미 연결되어 있습니다.
) else (
  git clone https://github.com/DDongs068/AI-Koo AI-Koo
)
set "GN="
for /f "delims=" %%i in ('git config --global user.name') do set "GN=%%i"
if not defined GN git config --global user.name "TOPIS sync"
set "GE="
for /f "delims=" %%i in ('git config --global user.email') do set "GE=%%i"
if not defined GE git config --global user.email "topis-sync@users.noreply.github.com"
echo.
echo 다음: 2_공지받기.bat 을 한 번 직접 실행하세요. 처음 올릴 때 GitHub 로그인 창이 뜨면 로그인하세요.
echo 로그인이 한 번 저장되면 그 뒤 자동 실행(3시간마다)도 올릴 수 있습니다.
pause

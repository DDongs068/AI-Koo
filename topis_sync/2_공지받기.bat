@echo off
cd /d "%~dp0"
if not exist "키.txt" (
  echo 키.txt 파일이 없습니다. 메모장으로 만들어 API 키 한 줄만 적어 저장하세요.
  pause
  exit /b
)
set /p TOPIS_API_KEY=<"키.txt"
if not exist "노선데이터.xlsx" (
  echo 노선데이터.xlsx 파일이 이 폴더에 없습니다.
  pause
  exit /b
)
if not exist "정류장위치.xlsx" (
  echo 정류장위치.xlsx 파일이 이 폴더에 없습니다.
  pause
  exit /b
)
set "REPOARG="
if exist "AI-Koo\.git" set "REPOARG=--repo-dir AI-Koo"
python topis_sync.py run --route-xlsx "노선데이터.xlsx" --loc-xlsx "정류장위치.xlsx" %REPOARG%
echo.
echo 끝났습니다. data\merged 폴더의 topis_v1_active.csv 가 결과입니다.
pause

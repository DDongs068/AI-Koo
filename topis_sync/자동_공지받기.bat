@echo off
rem 작업 스케줄러가 부르는 파일. 결과 한 줄을 화면에 20초 보여주고, 전체 기록은 data\run_log.txt 에 덧붙입니다.
cd /d "%~dp0"
if not exist data mkdir data
set /p TOPIS_API_KEY=<"키.txt"
set "REPOARG="
if exist "AI-Koo\.git" set "REPOARG=--repo-dir AI-Koo"
echo ===== %date% %time% ===== >> data\run_log.txt
python topis_sync.py run --route-xlsx "노선데이터.xlsx" --loc-xlsx "정류장위치.xlsx" %REPOARG% > data\last_output.txt 2>&1
type data\last_output.txt >> data\run_log.txt
echo.
echo ==================================================
findstr /b "결과:" data\last_output.txt
findstr /c:"Traceback" /c:"Error" /c:"실패" /c:"오류" data\last_output.txt
echo ==================================================
timeout /t 20 /nobreak >nul

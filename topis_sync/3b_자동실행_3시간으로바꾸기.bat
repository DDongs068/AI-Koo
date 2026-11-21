@echo off
cd /d "%~dp0"
schtasks /create /tn "TOPIS_공지받기" /tr "\"%~dp0자동_공지받기.bat\"" /sc hourly /mo 3 /f
echo.
echo 위에 "성공"이라고 나오면 3시간마다 실행으로 바뀐 것입니다.
pause

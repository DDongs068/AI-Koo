@echo off
cd /d "%~dp0"
echo 5분마다 자동으로 공지를 받도록 Windows 작업 스케줄러에 등록합니다 (시험용).
echo 이미 등록된 것이 있으면 이 설정으로 바뀝니다.
schtasks /create /tn "TOPIS_공지받기" /tr "\"%~dp0자동_공지받기.bat\"" /sc minute /mo 5 /f
echo.
echo 위에 "성공"이라고 나오면 끝입니다. 5분마다 까만 창이 20초 떴다 사라지며 결과 한 줄이 보입니다.
echo 시험이 끝나면 3b_자동실행_3시간으로바꾸기.bat 을 실행하세요.
echo 등록을 없애려면: schtasks /delete /tn "TOPIS_공지받기" /f
pause

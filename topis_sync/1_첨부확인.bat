@echo off
cd /d "%~dp0"
echo 6341번 공지의 첨부파일 받기를 시험합니다 (1~2분 걸릴 수 있음)...
python topis_sync.py probe 6341
echo.
echo 끝났습니다. 위 까만 창을 캡처해서 Claude에게 보내주세요.
echo (data\raw\6341 폴더에 notice.json 과 받은 첨부 파일이 생깁니다)
pause

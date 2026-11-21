@echo off
cd /d "%~dp0"
echo [1/1] 필요한 프로그램을 설치합니다...
python -m pip install pandas openpyxl
echo.
echo 위에 오류가 없으면 끝났습니다. 아무 키나 누르세요.
pause

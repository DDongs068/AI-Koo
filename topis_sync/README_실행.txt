[처음 한 번만]
1) 파이썬이 있어야 합니다. 0_설치(처음한번).bat 을 더블클릭했을 때 "python을 찾을 수 없다"가 나오면
   https://www.python.org/downloads/ 에서 설치하세요. 설치 첫 화면 아래 "Add python.exe to PATH" 에 꼭 체크.
2) PDF 첨부를 읽으려면 poppler 가 필요합니다.
   https://github.com/oschwartz10612/poppler-windows/releases 에서 최신 Release-...zip 을 받아
   이 폴더(sync_pkg) 안에 풀고, 풀린 폴더 이름을 poppler 로 바꾸세요.
3) 이 폴더에 파일 3개를 넣으세요.
   - 노선데이터.xlsx (기존 노선-정류소 순번 파일, 이름을 이렇게 바꿔서)
   - 정류장위치.xlsx (정류소 위치 파일)
   - 키.txt (메모장에 서울 열린데이터광장 API 키 한 줄만 적고 저장)
   ※ 키는 다른 사람에게 보내지 마세요.

[쓰는 순서]
0_설치(처음한번).bat  더블클릭  (한 번만)
1_첨부확인.bat        더블클릭  → 까만 창 화면을 캡처해서 Claude에게 보내기
2_공지받기.bat        더블클릭  → data\merged\topis_v1_active.csv 가 결과

[자동으로 돌리기]  3_자동실행등록.bat 더블클릭 → 3시간마다 자동 실행(컴퓨터가 켜져 있을 때). 결과 기록: data\\run_log.txt
[주의] 샘플 파일(JTBC 등)은 data 폴더 밖에 두세요. 지난 공지 정리할 때 data 안을 지웁니다.
출처표시 필수, 상업적 이용 금지(공공누리 2유형).
4_공지별요약보기.bat  더블클릭 → 어떤 공지가 몇 행을 만들었는지, 처리 못 한 공지가 무엇인지 보여줌\n
[깃허브로 자동 올리기]
5_깃허브연결.bat  더블클릭 (처음 한 번, git 설치 필요) → 2_공지받기.bat 을 직접 한 번 실행해 GitHub 로그인
이후에는 결과(data\merged\topis_v1_*.csv)가 바뀔 때만 저장소의 data/notices/ 폴더에 자동으로 올라갑니다. 바뀐 게 없으면 올리지 않습니다.
다음 팀 주소: https://raw.githubusercontent.com/DDongs068/AI-Koo/main/data/notices/topis_v1_active.csv
※ 공개 저장소라면 누구나 볼 수 있습니다. 키.txt·data 폴더는 올라가지 않습니다(data/notices 만 올림).

[자동 실행 주기]
3_자동실행등록.bat        → 5분마다 (시험용, 결과 한 줄이 20초 화면에 뜸. 예: "[14:25] 받을 새 공지 없음")
3b_자동실행_3시간으로바꾸기.bat → 시험이 끝나면 3시간마다로 변경

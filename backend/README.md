# CITYFLOW 경로 엔진 전달 패키지 (엔진 전용)
- 이 엔진은 "출발·도착·시각 → 우회·무정차 반영 경로"만 계산합니다. 화면 표시는 UI 쪽 방식대로 하세요.
- 시작: PROMPT_FOR_UI_BUILDER.md 를 읽고 AI에게 첨부와 함께 전달 / 직접 하려면 docs/API.md
- engine/ 엔진 · server/ HTTP 서버 · data/ 데이터 · docs/ 명세·알려진 문제
- 데이터는 11/1·3/15 행사 기준. 자동 생성 우회 설정 96개 노선은 검수 필요(data/auto_generated_routes.txt)
- [2026-11-21] 지하철 1~8호선 추가: data/subway-routes.json, 요청 "subway":false로 끌 수 있음, 응답 legs[].mode = "bus"|"subway" (docs/API.md 참고)

## 통합 버전 (Route B 최종 엔진)
- 통제 판정·우회: 이 엔진 그대로 (`cityflow-data.json`의 115개 공지 노선)
- 버스 노선 확대: `data/extra-routes.json` 519개 노선 추가 (총 634개). 통제 공지에 없는 노선 = 통제 영향 없음. 실제 도로 선형(paths.zip) 포함
  - 제외: 공지가 있지만 우회 설정이 없는 61개 노선(판정을 보장할 수 없어 뺌), 야간·새벽·심야 노선 23개(운행 시간 데이터 없음)
  - 다시 만들기: `python3 tools/mkextra.py . <cityflow.db> <paths 폴더>`
- 지하철 1~8호선: `data/subway-routes.json` (통제 영향 없음)
- `/health`에 `busRoutes`, `subwayRoutes` 표시. `EXTRA_PATH`로 파일 위치 변경 가능

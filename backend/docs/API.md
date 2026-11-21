# CITYFLOW 엔진 API

## 실행
```
KAKAO_REST_KEY=<카카오 REST 키> PORT=8080 node server/server.js     # Node 18+, 의존성 없음
```
- 시작하면 11/1(nov) 우회 선 계산을 시작함(카카오 길찾기 ~190회, 수 분 걸릴 수 있음). 끝나기 전 요청은 기다렸다가 응답. 진행 상황: GET /health
- 3/15 행사는 요청에 `"scen":"mar"` (처음 요청 때 계산)
- 다른 위치의 데이터 사용: `DATA_PATH=/경로/cityflow-data.json`

## POST /route
요청(JSON)
```
{ "scen":"nov", "origin":{"lat":37.449,"lon":126.453,"name":"인천공항"}, "destination":{"lat":37.579,"lon":126.995,"name":"창경궁"},
  "departure":"2026-11-01T08:30:00+09:00", "topN":3, "geometry":true, "subway":true }
```
- subway: 지하철 1~8호선 포함 여부(기본 true). false면 버스만으로 탐색
- departure: ISO8601, 반드시 +09:00 포함. geometry:false면 좌표 생략(목록만 필요할 때)

응답
```
{ "found":true, "scen":"nov", "notes":{"detourFailed":["705 (...)"]},
  "departure":"...Z",
  "normalRoute":{ "minutes":108.7, "walkM":327, "legs":[ {type:"walk",distanceM,geometry?} | {type:"bus",route,from,to,fromSeq,toSeq,minutes,geometry?} ] },
  "candidates":[ { "rank":1, "totalMinutes":108.7, "arrival":"ISO",
     "legs":[ {type:"walk", from, to, distanceM, minutes, geometry?},
              {type:"bus", mode:"bus"|"subway", route, from, to, stops:[{seq,name,ars,lat,lon}...], skippedSeqs:[...], detour:bool, minutes, geometry?} ] } ] }
```
- mode:"subway" 이면 지하철 구간. route는 "2호선 외선", "5호선 방화행"처럼 호선 + 운행 방향. 지하철 stops의 ars는 빈 문자열
- normalRoute = 통제가 없을 때의 최적 경로, candidates = 통제·우회를 반영한 다시 찾은 경로(환승 포함, 순위순)
- geometry = [[lat,lon],...] 그리기용 좌표. skippedSeqs = 이 구간에서 정차하지 않고 지나치는 정류소 순번(stops에 포함됨)
- found:false 이면 출발·도착 가까이 정류소가 없음. 오류는 {error}와 HTTP 400/500

## 표시할 때 지켜 달라는 것
- 추정값(우회 지연, 통제 종료 시각)은 "추정", 자동 생성 우회 설정 노선(data/auto_generated_routes.txt)이 들어간 결과는 "확인 필요"
- 표시 모양은 UI 쪽 방식대로. 단 우회 구간(detour:true)과 정상 경로는 구분되게

## 지하철 (2026-11-21 추가)
- data/subway-routes.json: 1~8호선 23개 운행 방향(2호선 외선·내선 1.5바퀴, 성수·신정지선, 5호선 마천지선, 6호선 응암순환 포함)
- 출처: 서울교통공사 역간거리 및 소요시간, 1~8호선 역사 좌표. 좌표 오류 보정(잠실새내·발산·신답은 역간거리 비율 보간, 용답은 신답 칸 좌표). 8호선 암사역사공원 제외(좌표 없음)
- 소요시간: 역간 표준 운행시간 + 정차 0.5분. 대기 4분 + 승강장↔지상 2분(추정, PARAMS.subwayWait·subwayEgress)
- 통제 영향 없음(무정차 공지 대상 아님). 다른 호선의 같은 이름 역은 좌표를 하나로 맞춰 환승 도보(300m) 연결
- 지하철 선은 역 사이 직선(geometry). 9호선·신분당선·공항철도·경의중앙선 등은 미포함
- 다른 파일 사용: SUBWAY_PATH=/경로/subway-routes.json, 파일이 없으면 버스만

## 알려진 한계
- 705번 우회 선 계산 실패(정류소 39·40 누락) → 정상 운행으로 처리됨(notes.detourFailed)
- 111·241·2016번은 공지 CSV와 우회 설정이 다름
- 카카오·OSRM 호출 실패 구간은 직선으로 근사되어 좌표가 튈 수 있음
- 이 서버·엔진은 카카오 길찾기 호출을 개발 환경에서 검증하지 못했음 (네트워크 차단 → 직선 대체로만 테스트)

## 데이터 갱신
- data/cityflow-data.json: routes(정류소·도로좌표), headway, scen.{nov,mar}.cfg(우회 설정)·이벤트. 행사·우회가 바뀌면 이 파일을 교체하고 서버 재시작

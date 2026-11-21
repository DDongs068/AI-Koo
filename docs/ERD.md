# 데이터 모델 (ERD)

Route B 는 **관계형 DB 한 벌**로 공지를 정규화하고(수집·판정 단계), 조회 때 쓰는 **엔진 데이터 한 벌**로 굳혀 배포한다. 둘을 나눈 이유는 아래 "왜 두 벌인가"에 적었다.

## 1. 수집·판정 단계 (SQLite `cityflow.db`)

```mermaid
erDiagram
    NOTICE ||--o{ EVENT : "공지 1건이 여러 무정차 행"
    ROUTE  ||--o{ ROUTE_STOP : "노선의 정류소 순번"
    STOP   ||--o{ ROUTE_STOP : "한 정류소는 여러 노선이 경유"
    ROUTE  ||--o{ EVENT : "어느 노선이 통제를 받나"
    STOP   ||--o{ EVENT : "어느 정류소에 서지 않나"

    NOTICE {
        string 공지ID PK
        string 공지제목
        string 원문링크
        string 등록시각
        string 공지상태
        string 첨부파일
    }
    EVENT {
        int    event_id PK
        string route_name FK
        string direction "공항방향 등"
        string direction_basis "원문 또는 화살표 추정"
        string event_date "우회일자"
        string start_text "시작시각"
        string end_text "종료시각"
        string skipped_stop_name "무정차 정류소"
        string ars_id FK "정류소 5자리"
        int    stop_sequence "노선 내 순번 ★판정 기준"
        string review_state "확인 또는 확인 필요"
        string old_route_text "기존 경로"
        string detour_route_text "우회 경로"
        int    pdf_page "원문 근거"
    }
    ROUTE {
        string route_id PK "서울시 노선ID 9자리"
        string route_name "6002 등"
    }
    STOP {
        string node_id PK
        string ars_id UK "정류소 5자리"
        string name
        float  lng
        float  lat
    }
    ROUTE_STOP {
        string route_id FK
        int    seq "순번 ★"
        string ars_id FK
        string name
        float  lng
        float  lat
    }
```

규모: `ROUTE_STOP` 41,688행 · `STOP` 11,236행 · `ROUTE` 718행 · `EVENT` 2,905행(5개 행사일).

### 판정의 축은 `stop_sequence`
정류소 **이름**은 공지와 노선 데이터가 서로 다르게 적는다(`한국은행(스프라지르명동)` 같은 표기). 그래서 이름이 아니라 **노선 내 순번**으로 판정한다. 순번을 못 채운 행은 판정에 쓰지 않고 `topis_v1_hold.csv` 로 뺀다.

`ars_id` 는 **방향까지 구분한다**(종로4가.종묘 = `01018` 여의도방향 / `01017` 망우동방향). 그래서 ARS 로 맞추면 방향이 공짜로 따라온다. 공지의 `방향` 칼럼은 1,246/2,729행이 "화살표 추정"이라 신뢰도가 낮고, `direction_basis` 에 그 근거를 남긴다.

## 2. 조회 단계 (엔진 데이터 `backend/data/*.json`)

```mermaid
erDiagram
    CITYFLOW_DATA ||--o{ ROUTE_GEOM : routes
    CITYFLOW_DATA ||--o{ SCENARIO : scen
    SCENARIO      ||--o{ EVENT_ROW : events
    SCENARIO      ||--o{ DETOUR_CFG : cfg
    EXTRA_ROUTES  ||--o{ ROUTE_GEOM : "통제 없는 519노선"
    SUBWAY        ||--o{ SUBWAY_LINE : "1~8호선 23개 운행방향"

    CITYFLOW_DATA {
        object routes "115개 공지 노선"
        object headway "720개 노선 배차(분)"
        object scen "nov, mar"
    }
    ROUTE_GEOM {
        string no "노선명"
        string routeId
        array  stops "seq, ars, name, lat, lon"
        array  path "실제 도로 좌표 [[lat,lon]...]"
    }
    SCENARIO {
        string label
        string date
        array  events "무정차 행"
        array  hold "판정 보류"
        object cfg "우회 설정 109노선"
        array  auto "자동생성 96노선(검수 필요)"
        string defEnd "종료시각 미기재 시 기본값"
    }
    DETOUR_CFG {
        string no
        array  window "우회 구간 순번 범위"
        array  skip "무정차 순번"
        array  gaps "우회선 조립 규칙"
    }
    SUBWAY_LINE {
        string no "2호선 외선 등"
        array  stops
        array  runSec "역간 소요시간"
    }
```

### 왜 두 벌인가
조회 때마다 SQL 로 순번을 맞추고 우회선을 다시 계산하면 응답이 느리다. 그래서 공지가 갱신될 때 한 번만 정규화·검증해 JSON 으로 굳히고, 엔진은 메모리에 올려 쓴다. 엔진은 **의존성이 없고 DB 도 필요 없다**(Node 18+ 단독 실행).

### 좌표의 출처를 항상 남긴다
한 구간의 선이 무엇으로 그려졌는지 응답에 `detour` 로 표시하고, 화면은 그걸 받아 `path_src` 로 보여 준다.

| 표시 | 뜻 | 신뢰도 |
|---|---|---|
| 노선 공식 형상 | 서울시 `getRoutePath` 의 실제 운행 좌표를 구간만 잘라 쓴 것 | 높음 |
| 우회 좌표(엔진 계산) | 통제로 달라진 구간. 같은 길을 달리는 다른 노선의 공식 경로 차용 > 자기 경로 역방향 재사용 > 카카오 길찾기 순으로 조립 | 중간 |
| 역 사이 직선 | 지하철 구간 | 표시용 |

## 3. 공지 수집 파이프라인

```mermaid
flowchart LR
    A["서울 TOPIS 공지사항<br/>selectNoticeList.do"] --> B["첨부 내려받기<br/>selectNoticeFileDown.do<br/>(PDF·HWPX·XLSX)"]
    B --> C["원문 파싱<br/>노선·정류소·시각 추출"]
    C --> D["노선별 정류소 XLSX 대조<br/>ARS → 순번 매칭"]
    D --> E{"순번을<br/>특정했나"}
    E -->|예| F["topis_v1_active.csv<br/>판정에 사용"]
    E -->|아니오| G["topis_v1_hold.csv<br/>판정 제외 · 경고만"]
    F --> H["cityflow.db events"]
    H --> I["cityflow-data.json<br/>엔진 데이터"]
```

정류소 매칭은 3단계로 내려간다: **ARS 일치 → 이름 정규화 일치 → 좌표 근접(150m)**. 노선명도 정규화한다(`N15(심야)`→`N15`, `급행370`→`370`, `110A고려대`→`110A`). 숫자만으로 맞추면 안 된다 — 마을버스가 2자리 번호를 공유해 `07` 하나에 16개 노선이 걸린다(종로07·강남07·서초07…).

출처: 서울특별시 TOPIS (공공누리 제2유형 · 출처표시, 상업적 이용 금지), 서울교통공사 역간거리·소요시간.

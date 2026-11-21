"""팀원용: 서울 버스 우회·무정차 공지 CSV를 GitHub에서 받아 검사하고(선택) 엔진에 넣는다.

사용 예
  python fetch_notices.py                       # ./notices/topis_v1_active.csv 로 받기 + 검사
  python fetch_notices.py --all                 # hold, 우회경로 파일도 같이 받기
  python fetch_notices.py --out engine/data/events --load-v1 --engine-dir engine --db cityflow.db
        # 받은 뒤 `python -m cityflow load-v1 --db cityflow.db --active <받은 파일>` 까지 실행 (engine 폴더에서)

받은 파일은 매번 통째로 교체된다(다운로드가 실패하면 기존 파일은 그대로 둔다).
csv는 엑셀로 열어 저장하지 말 것(정류소ID 앞의 0이 지워진다). 출처: 서울특별시 TOPIS (공공누리 2유형: 출처표시, 상업적 이용 금지)
"""
import argparse
import csv
import io
import os
import subprocess
import sys
import urllib.request

BASE = "https://raw.githubusercontent.com/DDongs068/AI-Koo/main/data/notices/"
FILES = {"active": "topis_v1_active.csv", "hold": "topis_v1_hold.csv", "우회경로": "topis_v1_우회경로.csv"}
NEED = ["공지ID", "노선번호", "정류소ID", "정류소순번", "우회일자", "시작시각", "종료시각", "종료시각구분", "확인상태", "매칭결과"]


def download(url, dest):
    from urllib.parse import quote, urlsplit, urlunsplit
    sp = urlsplit(url)
    url = urlunsplit((sp.scheme, sp.netloc, quote(sp.path), sp.query, sp.fragment))   # 한글 파일 이름
    req = urllib.request.Request(url, headers={"User-Agent": "fetch_notices"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    tmp = dest + ".part"
    open(tmp, "wb").write(data)
    os.replace(tmp, dest)                       # 다 받은 뒤에만 교체
    return data


def check_active(data):
    rows = list(csv.DictReader(io.StringIO(data.decode("utf-8-sig"))))
    miss = [c for c in NEED if rows and c not in rows[0]]
    if miss:
        sys.exit(f"열이 빠져 있음: {miss} — 형식이 바뀌었는지 확인하세요")
    notices = {r["공지ID"] for r in rows}
    routes = {r["노선번호"] for r in rows}
    days = sorted({r["우회일자"] for r in rows if r["우회일자"]})
    check = sum(1 for r in rows if r["확인상태"] == "확인 필요")
    bad_id = sum(1 for r in rows if len(r["정류소ID"]) != 5)
    print(f"행 {len(rows)} · 공지 {len(notices)}건 · 노선 {len(routes)}개 · 날짜 {days[0] if days else '-'} ~ {days[-1] if days else '-'}")
    print(f"확인 필요 {check}행 · 정류소ID가 5자리가 아닌 행 {bad_id} (0이어야 정상)")
    if bad_id:
        print("※ 정류소ID 앞의 0이 지워졌다면 엑셀로 저장한 파일입니다. 다시 받으세요.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="notices", help="받아서 저장할 폴더(기본 ./notices)")
    ap.add_argument("--all", action="store_true", help="hold, 우회경로 파일도 같이 받기")
    ap.add_argument("--url", default=BASE, help="내려받을 주소(끝에 / 포함). 시험용으로 file:///… 도 가능")
    ap.add_argument("--load-v1", action="store_true", help="받은 active 파일을 엔진에 적재(python -m cityflow load-v1)")
    ap.add_argument("--engine-dir", default="engine")
    ap.add_argument("--db", default="cityflow.db")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    kinds = ["active", "hold", "우회경로"] if a.all else ["active"]
    data = None
    for k in kinds:
        dest = os.path.join(a.out, FILES[k])
        try:
            d = download(a.url + FILES[k], dest)
        except Exception as ex:  # noqa: BLE001
            sys.exit(f"받기 실패({FILES[k]}): {ex} — 기존 파일은 그대로 둡니다")
        print(f"받음: {dest} ({len(d):,}바이트)")
        if k == "active":
            data = d
    check_active(data)
    if a.load_v1:
        active = os.path.abspath(os.path.join(a.out, FILES["active"]))
        cmd = [sys.executable, "-m", "cityflow", "load-v1", "--db", a.db, "--active", active]
        print("실행:", " ".join(cmd), f"(폴더: {a.engine_dir})")
        subprocess.run(cmd, cwd=a.engine_dir, check=True)


if __name__ == "__main__":
    main()

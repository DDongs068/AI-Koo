#!/usr/bin/env python3
"""TOPIS 공지 자동 수집 → 변환(active / hold / 우회경로) → 보관 기간 정리.

  python topis_sync.py run  --route-xlsx 노선별정류소.xlsx --loc-xlsx 정류소위치.xlsx   (API 키는 환경변수 TOPIS_API_KEY)
  python topis_sync.py probe 6341                  공지 상세 페이지의 첨부 링크 후보를 보여 주고 page.html을 저장
  python topis_sync.py cleanup                     보관 기간이 지난 자료만 지우기

보관 규칙(기본): 행사 종료일이 어제보다 이전이면 삭제(--past-days 1), 시작일이 오늘부터 7일보다 뒤면 아직 받지 않음(--future-days 7).
시험용: --xml 공지목록.xml --attach-dir 첨부폴더 --today 2026-11-21 로 네트워크 없이 돌릴 수 있다(첨부 파일명은 '공지ID_아무이름.pdf|xlsx').
"""
import subprocess, argparse, datetime as dt, glob, hashlib, html, json, os, re, shutil, sys, time
import urllib.request
import xml.etree.ElementTree as ET

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from classify import classify, strip as strip_html  # noqa: E402
from verify import Ref, verify, finalize, norm_id  # noqa: E402
from xlsx_source import read_notice_xlsx  # noqa: E402
import parse_notice_pdf as pnp  # noqa: E402
import build_detour_path as bdp  # noqa: E402
from run_verify import COLS, ID_COLS  # noqa: E402

API = "http://openapi.seoul.go.kr:8088/{key}/xml/NoticeList/{a}/{b}/"
DAYS = "월화수목금토일"
RANGE_WORDS = re.compile(r"~|…|부터|까지|↔|⇔|⟷|[-–—]")
SAFE = ("일치", "순번 보완")


# ───────────────────────── 네트워크 ─────────────────────────
def http_get(url, binary=False, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (topis_sync)"})
            with urllib.request.urlopen(req, timeout=40) as r:
                data = r.read()
                return (data, dict(r.headers)) if binary else data.decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"요청 실패: {url[:80]}… ({last})")


def fetch_notice_xml(key, out_path):
    """1~1000, 1001~2000 … 끊어서 받아 한 파일의 <row> 목록으로 합친다."""
    rows, a, total = [], 1, None
    while total is None or a <= total:
        b = a + 999
        txt = http_get(API.format(key=key, a=a, b=b))
        root = ET.fromstring(txt)
        if total is None:
            total = int(root.findtext("list_total_count") or 0)
            res = root.find("RESULT")
            code = res.findtext("CODE") if res is not None else ""
            if code and code != "INFO-000":
                raise RuntimeError(f"API 오류 {code}: {res.findtext('MESSAGE')}")
        rows += list(root.iter("row"))
        a = b + 1
    new = ET.Element("NoticeList")
    for r in rows:
        new.append(r)
    ET.ElementTree(new).write(out_path, encoding="utf-8", xml_declaration=True)
    return out_path


ATT_HINT = re.compile(r"download|fileDown|file[_-]?down|atch|attach|/file/", re.I)
ATT_EXT = re.compile(r"\.(pdf|hwp|hwpx|xlsx|xls|zip|png|jpg|jpeg)(\?|$)", re.I)


def find_attachment_links(page_html, base_url):
    """상세 페이지에서 첨부 링크 후보를 모은다(실제 페이지 구조를 확인하기 전의 추정 규칙)."""
    from urllib.parse import urljoin
    out = []
    for m in re.finditer(r"""<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>""", page_html, re.S | re.I):
        href, label = m.group(1), strip_html(m.group(2))
        if href.lower().startswith(("javascript", "#", "mailto")):
            continue
        if ATT_HINT.search(href) or ATT_EXT.search(href) or ATT_EXT.search(label):
            out.append((urljoin(base_url, html.unescape(href)), label))
    seen, res = set(), []
    for u, l in out:
        if u not in seen:
            seen.add(u); res.append((u, l))
    return res


TOPIS = "https://topis.seoul.go.kr"


def http_post(url, data, tries=3):
    """TOPIS 상세 화면이 쓰는 방식 그대로: 폼 형식 POST → JSON (page.html의 commonAjax 참고)."""
    import urllib.parse
    body = urllib.parse.urlencode(data).encode("utf-8")
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=body, headers={
                "User-Agent": "Mozilla/5.0 (topis_sync)", "X-Requested-With": "XMLHttpRequest",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "Referer": f"{TOPIS}/notice/openNoticeView.do"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"요청 실패: {url} ({last})")


def download_attachments(entry, dest):
    """공지 상세 JSON(/notice/selectNotice.do)에서 첨부 파일명(apndFileNm, 2~4)을 읽고,
    파일마다 /notice/selectNoticeFileDownLoad.do 로 base64 내용을 받아 저장. 반환: (저장한 경로들, 안내 목록)."""
    import base64
    os.makedirs(dest, exist_ok=True)
    nid = entry["공지ID"]
    meta = http_post(f"{TOPIS}/notice/selectNotice.do", {"blbdDivCd": "02", "bdwrSeq": nid})
    rows = meta.get("rows") or []
    if not rows:
        raise RuntimeError(f"공지 {nid} 상세를 못 받음: {str(meta)[:120]}")
    rec = rows[0]
    slim = {k: (v if not (isinstance(v, str) and len(v) > 300) else f"<{len(v)}자>") for k, v in rec.items()}
    json.dump(slim, open(os.path.join(dest, "notice.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    got, info = [], []
    for idx in range(1, 5):
        name = rec.get("apndFileNm" + ("" if idx == 1 else str(idx)))
        if not name or not str(name).strip():
            continue
        r = http_post(f"{TOPIS}/notice/selectNoticeFileDownLoad.do", {"bdwrSeq": nid, "idx": idx})
        rr = (r.get("rows") or [None])[0] or {}
        b64 = rr.get("apndFile")
        if not b64:
            info.append((name, "내용이 비어 있음"))
            continue
        data = base64.b64decode(b64)
        kind = "pdf" if data[:4] == b"%PDF" else "xlsx" if data[:2] == b"PK" and b"xl/" in data[:4000] else \
            "hwp" if data[:4] == b"\xd0\xcf\x11\xe0" else (os.path.splitext(name)[1].lstrip(".").lower() or "bin")
        path = os.path.join(dest, f"{nid}_{idx}.{kind}")
        open(path, "wb").write(data)
        got.append(path)
        info.append((name, f"{len(data):,}바이트 → {os.path.basename(path)}"))
    return got, info


# ───────────────────────── 날짜 ─────────────────────────
def infer_year(month, day, reg):
    for y in (reg.year, reg.year + 1, reg.year - 1):
        try:
            d = dt.date(y, month, day)
        except ValueError:
            continue
        if -200 < (d - reg).days < 200:
            return d
    return dt.date(reg.year, month, day)


def event_dates(title, body, reg):
    """제목의 '11/22(일)' 또는 '11/22(일)~11/23(월)'에서 시작·종료일. 없으면 본문의 연-월-일. 그래도 없으면 None."""
    ds = [infer_year(int(a), int(b), reg) for a, b in re.findall(r"(\d{1,2})/(\d{1,2})\([" + DAYS + r"]\)", title)]
    if not ds:
        ds = [dt.date(int(y), int(m), int(d)) for y, m, d in
              re.findall(r"(20\d{2})\s*[.\-년]\s*(\d{1,2})\s*[.\-월]\s*(\d{1,2})", body)[:2]]
    if not ds:
        return None, None
    return min(ds), max(ds)


def body_times(body):
    """본문에서 시각 구간. 우선순위: 무정차일시 > 우회일시·우회기간 > 통제일시·통제기간 > 일시 > 행사일시 (행사 시간은 버스 영향 시간과 다르다)."""
    for key in (r"무정차\s*일시", r"폐쇄\s*시간", "우회일시", "우회기간", "통제일시", "통제기간", r"일\s*시", "행사일시"):
        m = re.search(key + r"[^\n]{0,60}?(\d{1,2}):(\d{2})\s*(?:\([^)\n]{0,12}\))?\s*~\s*(?:[^\n\d]{0,25})?(?:(?:\d{1,2}\s*[.월]\s*)?\d{1,2}\s*[.일]\s*(?:\([^)\n]*\))?\s*)?(\d{1,2}):(\d{2})", body)
        if m:
            return f"{int(m.group(1)):02d}:{m.group(2)}", f"{int(m.group(3)):02d}:{m.group(4)}"
    return "", ""


# ───────────────────────── 변환 ─────────────────────────
def expand_ids(page, ref, route_name):
    """PDF 한 쪽의 무정차 칸 → (정류소 ID 목록, 안내 문구들). 'A ~ B'는 노선 순번으로 펼친다."""
    txt = page["무정차칸"]
    found = pnp.find_ids(txt)
    notes = []
    ids = [i for i, _, _ in found]
    g = ref.by_route.get(route_name) if route_name else None
    if len(found) == 2 and g is not None:
        between = txt[found[0][2]:found[1][1]]
        if RANGE_WORDS.search(between) and not re.search(r"[,/]", between):
            seq = list(g.sort_values("순번")["ARS_ID"])
            a, b = found[0][0], found[1][0]
            if a in seq and b in seq:
                lo, hi = sorted((seq.index(a), seq.index(b)))
                ids = seq[lo:hi + 1]
                notes.append(f"공지 구간 {a}~{b}를 노선 순번대로 펼침({len(ids)}개)")
                if "↔" in between or "⇔" in between:
                    notes.append("양방향 표기(↔) 구간이라 이 방향만 펼침")
    dedup = list(dict.fromkeys(ids))
    return dedup, notes


def make_rows(entry, files, ref, fixes, meta_times):
    """공지 하나 → (rows DataFrame, 경고 목록)."""
    warn, rows = [], []
    base = dict(공지ID=entry["공지ID"], 공지제목=entry["제목"], 등록시각=entry["등록시각"], 수정시각=entry["수정시각"],
                원문링크=entry["원문링크"], 버전=str(entry["ver"]), 공지상태="취소" if entry["취소"] else "유효")
    xl = {}
    for f in files:
        if f.lower().endswith(".xlsx"):
            df, w = read_notice_xlsx(f)
            warn += [f"{os.path.basename(f)}: {x}" for x in w]
            for r in df.to_dict("records"):
                xl.setdefault(r["노선번호"], []).append(r)
    pdf_pages = {}
    for f in files:
        if f.lower().endswith((".pdf", ".hwpx")):
            pages = pnp.pdf_text(f).split("\f") if f.lower().endswith(".pdf") else pnp.hwpx_pages(f)
            for i, pg in enumerate(pages, 1):
                info = pnp.parse_page(pg)
                if info and info["노선번호"] not in pdf_pages:
                    info["PDF쪽"] = str(i)
                    pdf_pages[info["노선번호"]] = info
    for rt, info in pdf_pages.items():
        info.update(fixes.get(rt, {}))
    routes = list(dict.fromkeys(list(pdf_pages) + list(xl)))
    date = entry.get("event_start")
    for rt in routes:
        info = pdf_pages.get(rt, {})
        rn, _ = ref.resolve_route(rt)
        t0, t1 = info.get("시작시각", ""), info.get("종료시각", "")
        if not t0:
            t0, t1 = meta_times
        common = dict(base, 노선번호=rt, 우회일자=date.isoformat() if date else "", 시작시각=t0, 종료시각=t1,
                      기존=info.get("기존", ""), 우회=info.get("우회", ""), PDF쪽=info.get("PDF쪽", ""),
                      방향="", 방향근거="공지 ID로 특정(방향 표기 없음)")
        if info.get("시각비고"):
            common["비고"] = f"공지: 우회일시에 '{info['시각비고']}' 표기"
        stops = []                                   # (정류소ID, 이름, ID출처, 비고, 확인상태)
        if rt in xl:
            for r in xl[rt]:
                stops.append(dict(id=r["정류소ID"], name=r["무정차정류소"], src=r["ID출처"], note=r["비고"], st=r["확인상태"],
                                  seq=r.get("정류소순번", ""), op=""))
            for i in (info.get("무정차ID", "").split(",") if info else []):
                if i and i not in {s["id"] for s in stops}:
                    stops.append(dict(id=i, name="", src="PDF", note="PDF 무정차 칸에는 있으나 첨부 xlsx 목록에는 없어 PDF 기준으로 추가", st="확인 필요", seq="", op=""))
        elif info:
            ids, notes = expand_ids(info, ref, rn)
            for i in ids:
                explicit = i in info.get("무정차ID", "").split(",")
                stops.append(dict(id=i, name="", src="PDF" if explicit else "PDF구간(노선데이터)", note="; ".join(notes) if not explicit else "",
                                  st="확인" if explicit else "확인 필요", seq="", op=""))
            if not ids:
                txtn = info["무정차칸"]
                if re.search(r"없음|해당\s*없", txtn) or re.fullmatch(r"[\s\-–—·]*", re.sub(r"무정차|정류소", "", txtn)):
                    rows.append(dict(common, 무정차정류소="", 정류소ID="", ID출처="", 정류소순번="", 확인상태="확인", 무정차없음=True,
                                     비고="공지에 무정차 정류소 없음(우회만)"))
                else:
                    warn.append(f"[{rt}] PDF {info.get('PDF쪽')}쪽: 무정차 칸에서 정류소 번호를 못 읽음 → hold로 보냄 / 원문: {txtn[:80]}")
                    rows.append(dict(common, 무정차정류소="", 정류소ID="", ID출처="", 정류소순번="", 확인상태="확인필요", 무정차없음=None,
                                     비고=f"무정차 칸에서 정류소 번호를 못 읽음. 원문: {txtn[:120]}"))
        for s in stops:
            rows.append(dict(common, 무정차정류소=s["name"], 정류소ID=s["id"], ID출처=s["src"], 정류소순번=s["seq"],
                             확인상태=s["st"], 무정차없음=None, 운수사=s["op"],
                             비고=" / ".join(x for x in (common.get("비고", ""), s["note"]) if x)))
        if info and bdp_leak(info):
            warn.append(f"[{rt}] 우회/기존 경로 글에 다른 칸의 글자가 섞였을 수 있음 → data/fixes/{entry['공지ID']}.json 으로 고칠 수 있음")
    return pd.DataFrame(rows), warn


def bdp_leak(info):
    return bool(pnp.find_ids(info.get("우회", "") + " " + info.get("기존", ""))) or len(info.get("우회", "")) > 160 or info.get("우회", "").count("(시작)") > 1


def loose_ids(body, ref):
    """글에서 정류소 번호 찾기: (19-132, 19842) 같은 괄호 목록, '23285, 23641, …' 처럼 번호만 쉼표로 이은 줄.
    노선 데이터에 있는 번호만 인정한다(전화번호·날짜 같은 숫자가 섞이지 않게)."""
    known = set(ref.routes["ARS_ID"]) | set(ref.loc.index)
    found = [i for i, _, _ in pnp.find_ids(body)]
    for m in pnp.PAREN.finditer(body):
        for tok in re.split(r"[,/、\s]+", m.group(1).strip()):
            t = re.sub(r"^ID\s*[:：]\s*", "", tok)
            if re.fullmatch(r"\d{2}-\d{3}|\d{5}", t) and t.replace("-", "") in known:
                found.append(t.replace("-", ""))
    for line in body.splitlines():                      # 번호만 쉼표로 이은 줄은 데이터에 없어도 그대로 인정
        if re.fullmatch(r"[\s,、·/]*(\d{5}[\s,、·/]*)+", line):
            found += re.findall(r"\d{5}", line)
    return list(dict.fromkeys(found))


def body_rows(entry, body, ref, meta_times):
    """첨부가 없는 공지. ① 본문에 정류소 번호 + '대상 노선'이 있으면 그대로, ② 노선이 없으면(집회 무정차·폐쇄 공지)
    그 정류소를 지나는 모든 노선을 노선 데이터에서 찾아 붙인다(확인 필요 표시)."""
    ids = loose_ids(body, ref)
    m = re.search(r"대상\s*노선\s*[:：]?\s*([^\n]{3,120})", body)
    routes = re.findall(r"(?<![\d-])(\d{2,4}[A-Z]?)(?![\d-])", re.sub(r"총\s*\d+개\s*노선", "", m.group(1))) if m else []
    if not ids:
        return pd.DataFrame(), ["본문에서 정류소 번호를 못 찾음(첨부가 필요하거나 이름만 적힌 공지)"]
    kind = "정류소 폐쇄" if re.search(r"폐쇄", entry["제목"] + body[:400]) and not re.search(r"무정차\s*(일시|통과)", body) else "무정차"
    base = dict(공지ID=entry["공지ID"], 공지제목=entry["제목"], 등록시각=entry["등록시각"], 수정시각=entry["수정시각"],
                원문링크=entry["원문링크"], 버전=str(entry["ver"]), 공지상태="취소" if entry["취소"] else "유효",
                우회일자=entry["event_start"].isoformat() if entry.get("event_start") else "", 시작시각=meta_times[0], 종료시각=meta_times[1],
                방향="", 무정차없음=None, PDF쪽="", 무정차정류소="", 정류소순번="")
    if routes:
        rows = [dict(base, 노선번호=r, 정류소ID=i, ID출처="공지 본문", 방향근거="공지 ID로 특정(방향 표기 없음)", 확인상태="확인",
                     비고=f"본문 기재 기준({kind})") for r in routes for i in ids]
    else:
        hit = ref.routes[ref.routes["ARS_ID"].isin(ids)][["노선명", "ARS_ID"]].drop_duplicates()
        rows = [dict(base, 노선번호=r, 정류소ID=i, ID출처="공지 본문", 방향근거="정류소 ID로 노선 역추적(공지에 노선 표기 없음)",
                     확인상태="확인필요", 비고=f"{kind}: 공지에 노선이 없어 이 정류소를 지나는 모든 노선으로 봄")
                for r, i in zip(hit["노선명"], hit["ARS_ID"])]
        for i in ids:                                  # 지나는 노선을 못 찾은 정류소도 버리지 않고 hold 행으로 남김
            if i not in set(hit["ARS_ID"]):
                rows.append(dict(base, 노선번호="", 정류소ID=i, ID출처="공지 본문", 방향근거="정류소 ID로 노선 역추적(공지에 노선 표기 없음)",
                                 확인상태="확인필요", 비고=f"{kind}: 이 정류소를 지나는 노선을 노선 데이터에서 못 찾음"))
    return pd.DataFrame(rows), ([] if rows else ["본문의 정류소 번호가 어느 노선에도 없음"])


def to_v1(src, ref):
    for c in COLS:
        if c not in src:
            src[c] = ""
    df = finalize(verify(src, ref), ref)
    unread = (df["정류소ID"] == "") & (df["무정차정류소"] == "") & (df["매칭결과"] == "정류장 데이터에 없음")
    df.loc[unread, "매칭결과"] = "확인필요"            # 번호를 못 읽은 쪽은 '데이터에 없음'이 아니라 사람이 봐야 하는 행
    df["무정차정류소"] = [n or nm for n, nm in zip(df["무정차정류소"], df["정류소명_노선데이터"])]
    df["확인상태"] = df["확인상태"].replace({"확인됨": "확인", "확인필요": "확인 필요", "비고칸 해석": "확인 필요", "이름매칭(추정)": "확인 필요"})
    df["종료시각구분"] = ["지정" if v else "" for v in df["종료시각"]]
    df = df[df.get("공지상태", "") != "__none__"] if False else df
    for c in COLS:
        if c not in df:
            df[c] = ""
    df = df[COLS].fillna("")
    for c in ID_COLS:
        df[c] = df[c].astype(str)
    return df


# ───────────────────────── 보관 기간·장부 ─────────────────────────
def load_ledger(d):
    p = os.path.join(d, "ledger.json")
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {}


def save_ledger(d, led):
    json.dump(led, open(os.path.join(d, "ledger.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def in_window(start, end, today, past, future):
    """(보관 대상인가, 사유)"""
    if end < today - dt.timedelta(days=past):
        return False, "지남"
    if start > today + dt.timedelta(days=future):
        return False, "아직 이름"
    return True, ""


def cleanup(data, led, today, past, log):
    n = 0
    for nid, e in list(led.items()):
        end = dt.date.fromisoformat(e["event_end"]) if e.get("event_end") else None
        if end and end < today - dt.timedelta(days=past):
            for sub in ("raw", "out"):
                p = os.path.join(data, sub, nid)
                if os.path.isdir(p):
                    shutil.rmtree(p); n += 1
            e["status"] = "삭제됨(기간 지남)"
        if end and end < today - dt.timedelta(days=30):      # 장부 항목도 30일 뒤 정리
            led.pop(nid)
    log.append(f"보관 기간이 지나 지운 공지 폴더: {n}개")


# ───────────────────────── 한 번 돌리기 ─────────────────────────
def run(a):
    data = a.data_dir
    for sub in ("raw", "out", "merged", "fixes"):
        os.makedirs(os.path.join(data, sub), exist_ok=True)
    today = dt.date.fromisoformat(a.today) if a.today else dt.date.today()
    log = [f"실행일: {today}  보관: 종료 {a.past_days}일 지난 것은 삭제, 시작이 {a.future_days}일 뒤보다 먼 것은 보류"]
    ref = Ref(a.route_xlsx, a.loc_xlsx)
    xml_path = a.xml
    if not xml_path:
        key = a.key or os.environ.get("TOPIS_API_KEY")
        if not key:
            sys.exit("API 키가 없습니다. 환경변수 TOPIS_API_KEY 또는 --key 로 주세요.")
        xml_path = fetch_notice_xml(key, os.path.join(data, "raw", "NoticeList.xml"))
    led = load_ledger(data)
    root = ET.parse(xml_path).getroot()
    new = upd = canc = skipped_old = waiting = nobus = 0
    problems = []
    for r in root.iter("row"):
        g = lambda k: (r.findtext(k) or "")
        nid, title = g("bdwr_seq"), g("bdwr_ttl_nm")
        body = strip_html(g("bdwr_cts"))
        ok, why = classify(title, body)
        if not ok:
            nobus += 1
            continue
        reg = dt.datetime.strptime(g("create_date")[:10], "%Y-%m-%d").date()
        s, e = event_dates(title, body, reg)
        undated = s is None
        if undated:
            s = e = reg + dt.timedelta(days=3)
        okw, reason = in_window(s, e, today, a.past_days, a.future_days)
        old = led.get(nid)
        if not okw:
            skipped_old += reason == "지남"; waiting += reason == "아직 이름"
            if reason == "아직 이름":
                led[nid] = dict(old or {}, title=title, event_start=s.isoformat(), event_end=e.isoformat(), status="대기(기간 밖)")
            continue
        update = g("update_date")
        cancel = bool(re.search(r"취소|철회", title))
        if old and old.get("update_date") == update and old.get("status") == "처리됨":
            continue
        if old and str(old.get("status", "")).startswith("처리 못 함") and old.get("update_date_seen") == update \
                and time.time() - old.get("last_try", 0) < 3 * 3600 and not a.attach_dir:
            continue                                   # 첨부가 없어 실패한 공지는 3시간에 한 번만 다시 시도
        ok_before = old and old.get("status") == "처리됨"
        ver = (old.get("ver", 0) + 1) if ok_before else (old.get("ver", 0) + 1 if old and old.get("ver") else 1)
        entry = dict(공지ID=nid, 제목=title, 등록시각=g("create_date"), 수정시각=update, 원문링크=g("url"), ver=ver,
                     취소=cancel, event_start=s, event_end=e)
        # 첨부
        raw_dir = os.path.join(data, "raw", nid)
        files = []
        if a.attach_dir:
            files = sorted(glob.glob(os.path.join(a.attach_dir, f"{nid}_*")))
        elif not a.no_download:
            try:
                files, _ = download_attachments(entry, raw_dir)
            except Exception as ex:  # noqa: BLE001
                problems.append(f"[{nid}] 첨부를 받지 못함: {ex}")
        skipped = [f for f in files if f.lower().endswith((".hwp",))]
        if skipped:
            problems.append(f"[{nid}] .hwp 첨부는 읽지 못함(.hwpx·pdf·xlsx만 지원): " + ", ".join(os.path.basename(x) for x in skipped))
        files = [f for f in files if f.lower().endswith((".pdf", ".xlsx", ".hwpx"))]
        fixp = os.path.join(data, "fixes", f"{nid}.json")
        fixes = json.load(open(fixp, encoding="utf-8")) if os.path.exists(fixp) else {}
        times = body_times(body)
        try:
            if files:
                src, warn = make_rows(entry, files, ref, fixes, times)
                if src.empty:                              # 첨부에서 못 읽으면 본문(번호·대상 노선)으로 다시 시도
                    src2, warn2 = body_rows(entry, body, ref, times)
                    if not src2.empty:
                        src, warn = src2, warn + ["첨부에서는 행을 못 읽어 본문 기준으로 처리"]
                    else:
                        warn = warn + [f"첨부 {', '.join(os.path.basename(f) + '(' + format(os.path.getsize(f), ',') + 'B)' for f in files)}"
                                       " 에서 읽힌 노선·정류소 없음(그림 PDF이거나 표 모양이 다를 수 있음)"] + warn2
            else:
                src, warn = body_rows(entry, body, ref, times)
        except Exception as ex:  # noqa: BLE001
            src, warn = pd.DataFrame(), [f"변환 중 오류: {ex}"]
        status = "처리됨"
        if src.empty:
            status = "처리 못 함(첨부 필요)" if not files else "처리 못 함"
            led[nid] = dict(title=title, event_start=s.isoformat(), event_end=e.isoformat(), update_date="", status=status,
                            ver=(old or {}).get("ver", 0), last_try=time.time(), update_date_seen=update)
            problems.append(f"[{nid}] {title[:30]}… 행을 못 만듦 (첨부 {len(files)}개): " + "; ".join(warn))
            continue
        problems += [f"[{nid}] {w}" for w in warn]
        df = to_v1(src, ref)
        vdir = os.path.join(data, "out", nid, f"v{ver}")
        os.makedirs(vdir, exist_ok=True)
        act, hold = df[df["매칭결과"].isin(SAFE)], df[~df["매칭결과"].isin(SAFE)]
        act.to_csv(os.path.join(vdir, "active.csv"), index=False, encoding="utf-8-sig")
        hold.to_csv(os.path.join(vdir, "hold.csv"), index=False, encoding="utf-8-sig")
        if len(act):
            bdp.main(os.path.join(vdir, "active.csv"), a.route_xlsx, a.loc_xlsx, os.path.join(vdir, "우회경로.csv"))
        if cancel:
            problems.append(f"[{nid}] 취소·철회 공지: 같은 행사의 원래 공지가 있으면 그쪽도 내려야 함 — {title[:40]}")
        led[nid] = dict(title=title, event_start=s.isoformat(), event_end=e.isoformat(), update_date=update, status=status, ver=ver,
                        rows=len(df), active=len(act), hold=len(hold), canceled=cancel, undated=undated)
        new += not ok_before; upd += bool(ok_before); canc += cancel
    cleanup(data, led, today, a.past_days, log)
    merged(data, led, log)
    save_ledger(data, led)
    log += [f"새 공지 {new}건 / 수정 {upd}건 / 취소 {canc}건 · 기간이 지나 건너뜀 {skipped_old}건 · 아직 이르다 보류 {waiting}건 · 버스 아님 {nobus}건"]
    log += ["확인할 것:"] + (["  " + p for p in problems] or ["  없음"])
    if getattr(a, "repo_dir", None):
        log += publish(a.repo_dir, a.repo_subdir, os.path.join(data, "merged"))
    gh = [l for l in log if l.startswith("깃허브")]
    n_ok = sum(1 for e in led.values() if e.get("status") == "처리됨" and not e.get("canceled"))
    now = dt.datetime.now().strftime("%H:%M")
    head = (f"[{now}] 받을 새 공지 없음 (처리된 공지 {n_ok}건 그대로)" if not (new or upd or canc)
            else f"[{now}] 새 공지 {new}건 · 수정 {upd}건 · 취소 {canc}건 반영 (처리된 공지 {n_ok}건)")
    log.append("결과: " + head + (" · " + gh[-1] if gh else ""))
    open(os.path.join(data, "merged", "summary.txt"), "w", encoding="utf-8").write("\n".join(log) + "\n")
    print("\n".join(log))


DEDUP_KEYS = {
    "active": ["노선번호", "방향", "우회일자", "시작시각", "종료시각", "종료시각구분", "정류소ID"],
    "hold": ["노선번호", "방향", "우회일자", "시작시각", "종료시각", "종료시각구분", "정류소ID"],
    "우회경로": ["노선번호", "방향", "우회일자", "시작시각", "종료시각", "경로번호", "순서", "원문표기"],
}
OUT_NAMES = {"active": "topis_v1_active.csv", "hold": "topis_v1_hold.csv", "우회경로": "topis_v1_우회경로.csv"}


def dedup_notices(df, kind):
    """서로 다른 공지가 같은 내용(같은 노선·정류소·날짜·시간)을 담으면 한 행으로 합친다. 마지막(번호가 큰) 공지 것을 남기고
    비고에 합친 공지 번호를 적는다. 한 공지 안의 행은 건드리지 않는다. 반환: (표, 합쳐서 줄어든 행 수)."""
    keys = [c for c in DEDUP_KEYS[kind] if c in df.columns]
    if df.empty or not keys:
        return df, 0
    d = df.copy()
    if kind != "우회경로":
        d = d[d["정류소ID"] != ""] if "정류소ID" in d else d
    grp = d.groupby(keys, sort=False)
    drop, notes = [], {}
    for _, g in grp:
        ids = sorted(set(g["공지ID"]), key=int)
        if len(ids) < 2:
            continue
        keep = g[g["공지ID"] == ids[-1]].index[0]
        drop += [i for i in g.index if i != keep and g.loc[i, "공지ID"] != ids[-1]]
        drop += [i for i in g[g["공지ID"] == ids[-1]].index[1:]] if False else []
        notes[keep] = "동일 내용 공지 병합: " + ", ".join(ids)
    out = df.drop(index=drop).copy()
    for i, t in notes.items():
        out.loc[i, "비고"] = " / ".join(x for x in (out.loc[i, "비고"], t) if x) if "비고" in out else t
    return out.reset_index(drop=True), len(drop)


def merged(data, led, log):
    parts = {"active": [], "hold": [], "우회경로": []}
    for nid, e in led.items():
        if e.get("status") != "처리됨" or e.get("canceled"):
            continue
        vdir = os.path.join(data, "out", nid, f"v{e['ver']}")
        for k in parts:
            p = os.path.join(vdir, f"{k}.csv")
            if os.path.exists(p):
                parts[k].append(pd.read_csv(p, dtype=str, encoding="utf-8-sig").fillna(""))
    cat = {}
    for k, v in parts.items():
        df = pd.concat(v, ignore_index=True) if v else pd.DataFrame(columns=COLS if k != "우회경로" else [])
        df, merged_n = dedup_notices(df, k)
        cat[k] = df
        df.to_csv(os.path.join(data, "merged", OUT_NAMES[k]), index=False, encoding="utf-8-sig")
        extra = f", 같은 내용 {merged_n}행 합침" if merged_n else ""
        log.append(f"합친 파일 {OUT_NAMES[k]}: {len(df)}행 (공지 {len(v)}건{extra})")
    if len(cat["active"]):
        vc = pd.concat([cat["active"], cat["hold"]])["매칭결과"].value_counts()
        log.append("매칭결과별: " + ", ".join(f"{k} {n}" for k, n in vc.items()))
        act = cat["active"]
        log.append(f"active 중 확인 필요 {int((act['확인상태'] == '확인 필요').sum())}행, 순번 빈 행 {int((act['정류소순번'] == '').sum())}행")


NOTICE_README = """# 서울 버스 우회·무정차 공지 (v1 CSV)

서울시 TOPIS 공지(버스안내)를 자동 수집해 만든 표준 CSV입니다. 3시간마다 갱신됩니다.

- `topis_v1_active.csv` — **지도·길찾기에 쓰는 파일.** 1행 = (노선, 정류소) 1개. 이 파일만 쓰면 됩니다.
- `topis_v1_hold.csv` — 자동 검사를 통과하지 못해 뺀 행(노선 데이터에 없는 정류소 등). 참고용.
- `topis_v1_우회경로.csv` — 우회 경로 지점(순서대로). 참고용.

이 파일들은 **그 시점에 유효한 공지 전체**입니다(지난 행사는 하루 뒤 빠지고, 앞으로 7일치까지 포함). 새 파일을 받으면 이전 것을 버리고 통째로 교체하세요.
열 이름으로 읽고, 정류소ID는 5자리 문자열로 다루세요(CSV는 UTF-8 BOM, 엑셀로 열어 저장하지 마세요).

출처: 서울특별시 TOPIS 공지사항 / 서울 열린데이터광장 (공공누리 제2유형: 출처표시, 상업적 이용 금지)
"""


def _git(repo, *args):
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, (r.stdout + r.stderr).strip()


def publish(repo, subdir, merged_dir):
    """합친 csv 3개를 git 저장소 폴더에 복사하고, 바뀐 것이 있을 때만 commit + push. 실패해도 예외를 던지지 않고 로그만 돌려준다."""
    try:
        if not os.path.isdir(os.path.join(repo, ".git")):
            return [f"깃허브: '{repo}' 는 git 저장소가 아님 → 5_깃허브연결.bat 을 먼저 실행"]
        lines = []
        rc, out = _git(repo, "pull", "--rebase", "--autostash")
        if rc != 0:
            lines.append("깃허브: 최신 내려받기(pull) 실패, 계속 진행 — " + out[:200])
        dest = os.path.join(repo, subdir)
        os.makedirs(dest, exist_ok=True)
        for n in OUT_NAMES.values():
            shutil.copyfile(os.path.join(merged_dir, n), os.path.join(dest, n))
        open(os.path.join(dest, "README.md"), "w", encoding="utf-8", newline="\n").write(NOTICE_README)
        _git(repo, "add", "--", subdir)
        rc, out = _git(repo, "status", "--porcelain", "--", subdir)
        if not out.strip():
            rc, ahead = _git(repo, "rev-list", "--count", "@{u}..HEAD")      # 저장(commit)만 되고 못 올린 것이 남아 있는지
            if rc == 0 and ahead.strip() not in ("", "0"):
                rc, out = _git(repo, "push")
                if rc != 0:
                    return lines + [f"깃허브: 이전에 못 올린 변경 {ahead.strip()}건 올리기(push) 실패 — {out[:300]}"]
                return lines + [f"깃허브: 이전에 못 올린 변경 {ahead.strip()}건을 올림 완료"]
            return lines + ["깃허브: 바뀐 내용 없음 → 올리지 않음"]
        n_act = sum(1 for _ in open(os.path.join(merged_dir, OUT_NAMES["active"]), encoding="utf-8-sig")) - 1
        rc, out = _git(repo, "commit", "-m", f"공지 데이터 갱신 {dt.datetime.now():%Y-%m-%d %H:%M} (active {n_act}행)")
        if rc != 0:
            hint = " → git config --global user.name / user.email 설정 필요" if "who you are" in out or "identity" in out else ""
            return lines + [f"깃허브: commit 실패{hint} — {out[:200]}"]
        rc, out = _git(repo, "push")
        if rc != 0:
            return lines + [f"깃허브: 올리기(push) 실패 — {out[:300]} (처음이면 2_공지받기.bat 을 직접 실행해 GitHub 로그인부터)"]
        return lines + [f"깃허브: 올림 완료 ({subdir}, active {n_act}행)"]
    except Exception as ex:  # noqa: BLE001
        return [f"깃허브: 올리는 중 오류 — {ex}"]


def probe(a):
    nid = a.notice_id
    key = a.key or os.environ.get("TOPIS_API_KEY")
    url = f"https://topis.seoul.go.kr/notice/openNoticeView.do?blbdDivCd=02&bdwrSeq={nid}"
    entry = {"공지ID": nid, "원문링크": url}
    dest = os.path.join(a.data_dir, "raw", nid)
    got, links = download_attachments(entry, dest)
    print("저장 폴더:", dest, "(notice.json = 공지 상세, 첨부 파일)")
    print("첨부 목록:")
    for n, m in links:
        print("  ", n, "|", m)
    print("받은 첨부:", got if got else "없음")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("run", "cleanup", "probe"):
        p = sub.add_parser(name)
        p.add_argument("--data-dir", default="data")
        p.add_argument("--key")
        p.add_argument("--today")
        p.add_argument("--past-days", type=int, default=1)
        p.add_argument("--future-days", type=int, default=7)
        p.add_argument("--route-xlsx")
        p.add_argument("--loc-xlsx")
        p.add_argument("--xml")
        p.add_argument("--attach-dir")
        p.add_argument("--no-download", action="store_true")
        p.add_argument("--repo-dir", help="깃허브 저장소를 내려받아 둔 폴더. 주면 결과 csv를 거기에 복사해 commit·push")
        p.add_argument("--repo-subdir", default="data/notices")
        if name == "probe":
            p.add_argument("notice_id")
    a = ap.parse_args()
    if a.cmd == "run":
        run(a)
    elif a.cmd == "probe":
        probe(a)
    else:
        today = dt.date.fromisoformat(a.today) if a.today else dt.date.today()
        led = load_ledger(a.data_dir); log = []
        cleanup(a.data_dir, led, today, a.past_days, log); merged(a.data_dir, led, log); save_ledger(a.data_dir, led)
        print("\n".join(log))


if __name__ == "__main__":
    main()

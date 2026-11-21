"""안내문 PDF → 노선별 우회일시(시작·종료시각)·기존 경로·우회 경로·무정차 칸의 정류소 ID.
표 모양이 공지마다 조금씩 달라 글자 순서가 뒤섞이는 경우가 있어, 결과는 항상 눈으로 확인하는 것을 전제로 한다.

사용: python -I parse_notice_pdf.py 안내문.pdf 출력.csv
"""
import re
import subprocess
import sys

import pandas as pd

ARS = re.compile(r"[(\[]\s*(?:ID\s*[:：]\s*)?(\d{2})\s*-?\s*(\d{3})\s*[)\]]")
PAREN = re.compile(r"[(\[]([^()\[\]]*)[)\]]")
ONE_ID = re.compile(r"(\d{2})\s*-?\s*(\d{3})")


def find_ids(text):
    """(19156) / (ID:02-605) / [14316] / (19-303 19-136) 형태의 정류소 번호를 글에 나온 순서대로 (번호, 시작위치, 끝위치)로."""
    out = []
    for m in PAREN.finditer(text):
        inner = re.sub(r"^\s*ID\s*[:：]\s*", "", m.group(1))
        if re.fullmatch(r"\s*\d{2}\s*-?\s*\d{3}(\s+\d{2}\s*-?\s*\d{3})*\s*", inner):
            for k in ONE_ID.finditer(inner):
                out.append(("".join(k.groups()), m.start(), m.end()))
    return out
TIME = re.compile(r"(\d{1,2}):(\d{2})\s*~\s*(?:익일|다음\s*날)?\s*(?:(?:\d{1,2}\s*[.월]\s*)?\d{1,2}\s*[.일]\s*(?:\([^)\n]*\))?\s*)?(\d{1,2}):(\d{2})")
TITLE = re.compile(r"^\s*([가-힣A-Z]{0,4}\d{1,5}(?:-\d{1,2})?[A-Z]?)\s*(?:번|노선)?\s*임시우회", re.M)


def _pdftotext_exe():
    """pdftotext(poppler) 위치: PATH → 이 스크립트 폴더 안의 pdftotext.exe 또는 poppler 폴더."""
    import glob
    import os
    import shutil
    p = shutil.which("pdftotext")
    if p:
        return p
    here = os.path.dirname(os.path.abspath(__file__))
    for pat in ("pdftotext.exe", "poppler*/**/pdftotext.exe", "xpdf*/**/pdftotext.exe"):
        g = glob.glob(os.path.join(here, pat), recursive=True)
        if g:
            return g[0]
    raise RuntimeError("pdftotext를 못 찾음 — poppler를 sync_pkg 폴더 안에 'poppler' 이름으로 풀어 두세요(README 참고)")


def pdf_text(path):
    return subprocess.run([_pdftotext_exe(), "-layout", path, "-"], capture_output=True, text=True, check=True,
                          encoding="utf-8", errors="replace").stdout


def clean(s):
    s = re.sub(r"\s+", " ", s).strip()
    return s


def parse_page(page):
    m = TITLE.search(page)
    if not m:
        return None
    route = m.group(1)
    body = page.split("※ 우회구간")[0].split("※ 우회 구간")[0]
    tm = TIME.search(body)
    start = f"{int(tm.group(1)):02d}:{tm.group(2)}" if tm else ""
    end = f"{int(tm.group(3)):02d}:{tm.group(4)}" if tm else ""
    note_time = ""
    after = body[tm.end():tm.end() + 14] if tm else ""
    if "통제시" in after:
        note_time = "통제시"
    elif tm and re.search(r"익일|다음\s*날|\d{1,2}\s*일", tm.group(0)) or (tm and end < start):
        note_time = "다음날 종료"
    # 기존·우회 칸: 소개 문장이 끝난 뒤부터 '무정차' 칸 직전까지
    intro_end = max((body.find(k) for k in ("바랍니다.", "예정입니다.", "실시하오니")), default=-1)
    nz = body.find("무정차", intro_end if intro_end > 0 else 0)
    region = body[(intro_end + 5 if intro_end > 0 else 0):nz if nz > 0 else None]
    # '기존'·'우회' 라벨 위치(한글에 붙어 있지 않은 것)
    lab = [(mm.start(), mm.group(1)) for mm in re.finditer(r"(?<![가-힣/])(기존|우회)(?![가-힣/])", region)]
    old = new = ""
    if lab:
        gi = next((p for p, w in lab if w == "기존"), None)
        wi = next((p for p, w in lab if w == "우회"), None)
        if gi is not None and wi is not None:
            if gi < wi:
                old, new = region[:wi], region[wi:]
            else:
                new, old = region[:gi], region[gi:]
            old = re.sub(r"(?<![가-힣/])기존(?![가-힣/])", " ", old)
            new = re.sub(r"(?<![가-힣/])우회(?![가-힣/])", " ", new, count=1)
    nos = body[nz:] if nz > 0 else ""
    kj = re.search(r"기종점[^\n]*\n", body)
    if kj and nz > 0:                       # 마을버스 표: '기종점' 칸 아래에 무정차 정류소가 여러 줄, 라벨은 가운데 줄에 있음
        nos = body[kj.end():]
    ids = [i for i, _, _ in find_ids(nos)]
    return dict(노선번호=route, 시작시각=start, 종료시각=end, 시각비고=note_time,
                기존=clean(old), 우회=clean(new), 무정차칸=clean(nos), 무정차ID=",".join(ids))


def hwpx_pages(path):
    """한글(.hwpx) 안내문 → 노선별 글(PDF 쪽과 같은 모양). hwpx는 zip 안의 XML이라 글자만 꺼내면 된다."""
    import zipfile
    z = zipfile.ZipFile(path)
    lines = []
    for n in sorted(x for x in z.namelist() if re.fullmatch(r"Contents/section\d+\.xml", x)):
        xml = z.read(n).decode("utf-8", "replace")
        for p in re.findall(r"<hp:p\b.*?</hp:p>", xml, re.S):
            t = "".join(re.findall(r"<hp:t>(.*?)</hp:t>", p, re.S))
            t = re.sub(r"<[^>]+>", "", t)
            t = t.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").strip()
            if t:
                lines.append(t)
    text = "\n".join(lines)
    text = re.sub(r"([가-힣A-Z]{0,4}\d{1,5}(?:-\d{1,2})?[A-Z]?)\s*번\s*\n\s*(임시우회)", r"\1번 \2", text)
    return [p for p in re.split(r"(?m)^(?=\s*[가-힣A-Z]{0,4}\d{1,5}(?:-\d{1,2})?[A-Z]?\s*번?\s*임시우회)", text) if p.strip()]


def main(pdf, out):
    rows = [r for r in (parse_page(p) for p in pdf_text(pdf).split("\f")) if r]
    df = pd.DataFrame(rows)
    df.to_csv(out, index=False, encoding="utf-8-sig")
    return df


if __name__ == "__main__":
    pd.set_option("display.width", 250, "display.max_colwidth", 90)
    print(main(*sys.argv[1:3]).to_string())

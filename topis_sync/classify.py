"""TOPIS 공지(NoticeList xml) → 버스 관련 여부 분류 + notices.csv.
포함: 본문/제목에 (노선번호 or 대상노선) + (우회/무정차/미정차/미운행/폐쇄) 가 같이 있거나, 정류소/정류장 번호와 무정차·폐쇄가 있는 공지.
제외: 버스 노선·정류소 언급 없이 도로·차선 통제만 알리는 공지. API 구분(통제안내/버스안내)은 참고만."""
import re, sys, html, xml.etree.ElementTree as ET
import pandas as pd

BUS = re.compile(r"버스|노선|무정차|미정차|정류소|정류장|승강장")
ACT = re.compile(r"우회|무정차|미정차|미운행|폐쇄|임시정류")
ROUTE = re.compile(r"(?<!\d)(\d{2,4}[A-Z]?)(?:번)?(?=[\s,)(·、/]|$)")
ARS = re.compile(r"(?<!\d)(\d{2}-\d{3}|\d{5})(?!\d)")
ATTACH = re.compile(r"첨부파일")

def strip(h):
    t = re.sub(r"<br\s*/?>|</p>|</div>|</tr>", "\n", h)
    t = re.sub(r"<[^>]+>", "", t)
    return re.sub(r"[ \t ]+", " ", html.unescape(t)).strip()

def classify(title, text):
    full = title + "\n" + text
    has_bus = bool(BUS.search(full)); has_act = bool(ACT.search(full))
    # 철도 등 버스 외 교통 공지는 제외
    if re.search(r"열차|철도", full) and not re.search(r"버스", full):
        return False, "버스 아님(철도)"
    if not has_bus:
        return False, "버스·정류소 언급 없음(도로 통제만)"
    if not has_act:
        return False, "우회·무정차·폐쇄 표현 없음"
    # '버스'가 '대상노선' 없이 단독 문구로만 나오는 경우까지 걸러냄
    if not re.search(r"대상\s*노선|무정차|미정차|정류소|정류장|임시우회|버스\s*임시|버스\s*교통", full):
        return False, "버스 언급이 약함"
    return True, "버스 우회·무정차·폐쇄 공지"

def run(xml_path):
    root = ET.parse(xml_path).getroot()
    rows = []
    for r in root.iter("row"):
        g = lambda k: (r.findtext(k) or "")
        title = g("bdwr_ttl_nm"); text = strip(g("bdwr_cts"))
        ok, why = classify(title, text)
        ids = sorted(set(ARS.findall(text)))
        attach = bool(ATTACH.search(text))
        kind = ""
        if ok:
            kind = "본문만(정류소 번호 있음)" if ids and not attach else ("본문+첨부" if ids else ("첨부 필요(본문에 정류소 번호 없음)" if attach else "본문만(번호 없음)"))
        rows.append({"공지ID": g("bdwr_seq"), "제목": title, "API구분": g("bdwr_div_nm"), "등록시각": g("create_date"),
                     "수정시각": g("update_date"), "원문링크": g("url"), "포함": ok, "사유": why, "유형": kind,
                     "본문_정류소번호수": len(ids), "첨부안내문구": attach})
    return pd.DataFrame(rows)

if __name__ == "__main__":
    d = run(sys.argv[1]); d.to_csv("notices.csv", index=False, encoding="utf-8-sig")
    print(d.포함.value_counts().to_dict()); print(d[d.포함].유형.value_counts().to_dict())

"""공지 첨부 xlsx(운수사별 시트) → 표준 입력 행. 폐쇄/무정차 표시된 정류소만 1행씩."""
import re
import pandas as pd
from verify import norm_id

CLOSED = re.compile(r"폐쇄|무정차|우회운행")   # 우회운행: 회사 양식 차이. 스마일레이스 5713에서 PDF 개수와 일치해 무정차로 해석(비고에 표시)


def read_notice_xlsx(path):
    x = pd.ExcelFile(path)
    summ = x.parse(0, dtype=str, header=None)
    summary_routes = set(summ.iloc[2:, 2].dropna().astype(str).str.strip()) - {"10", "노선번호"}
    rows, seen_routes, warnings = [], {}, []
    for s in x.sheet_names[1:]:                     # 첫 시트는 요약
        d = x.parse(s, dtype=str, header=None)
        hdr = d.index[d.iloc[:, 1].astype(str).str.contains("노선번호", na=False)][0]
        for _, r in d.iloc[hdr + 1:].iterrows():
            route = str(r[1]).strip()
            if route in ("nan", ""):
                continue
            remark = " ".join(str(v) for v in r[5:] if str(v) != "nan" and "<<" not in str(v))  # '<< 해당 노선으로 기입'은 양식 안내문
            raw_id = str(r[3]).strip()
            name = str(r[4]).strip()
            if raw_id in ("-", "nan", ""):
                rid = ""
            else:
                rid = norm_id(raw_id)
            if route not in summary_routes:
                if (route, s) not in [(w[0], w[1]) for w in warnings]:
                    warnings.append((route, s, f"요약 시트에 없는 노선번호(행 {r[2]}: {name}). 오기일 수 있음"))
                continue
            seen_routes.setdefault(route, [s, 0])
            if CLOSED.search(remark):
                seen_routes[route][1] += 1
                rows.append({"노선번호": route, "무정차정류소": name, "정류소ID": rid,
                             "ID출처": "공지(xlsx)" if rid else "", "정류소순번": "",
                             "방향": "", "방향근거": "", "비고": f"시트:{s}, 안내문순서:{r[2]}, 비고칸:{remark}" + (" (우회운행→무정차로 해석)" if "우회운행" in remark else ""),
                             "확인상태": "비고칸 해석" if "우회운행" in remark else ""})
    # 무정차 0개인 노선은 '우회만' 행으로
    for route, (s, n) in seen_routes.items():
        if n == 0:
            rows.append({"노선번호": route, "무정차정류소": "", "정류소ID": "", "무정차없음": True,
                         "방향": "", "방향근거": "", "비고": f"시트:{s}"})
    return pd.DataFrame(rows), warnings

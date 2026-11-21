"""사용법: python -I run_verify.py 입력(추출행).csv|공지xlsx 노선별정류소.xlsx 정류소위치.xlsx 출력.csv [노선명대응표.csv]
입력이 .xlsx면 스마일레이스형 첨부 xlsx로 보고 xlsx_source로 읽는다. 처리 요약을 출력 옆 .summary.txt로도 남긴다."""
import sys, re
sys.path.insert(0, __file__.rsplit("/", 1)[0] if "/" in __file__ else ".")
import pandas as pd
from verify import Ref, verify, finalize
from xlsx_source import read_notice_xlsx

COLS = ["공지ID", "공지제목", "등록시각", "수정시각", "원문링크", "버전", "공지상태",
        "노선번호", "방향", "방향근거", "우회일자", "시작시각", "종료시각", "종료시각구분", "기존", "우회",
        "무정차정류소", "정류소ID", "ID출처", "정류소순번", "공지상정류소수", "확인상태", "비고", "PDF쪽", "운수사",
        "NODE_ID", "ARS_ID_노선데이터", "정류소명_노선데이터", "노선명_노선데이터", "X좌표", "Y좌표", "매칭결과", "순번비움사유"]
ID_COLS = ["정류소ID", "NODE_ID", "ARS_ID_노선데이터", "공지ID", "정류소순번"]


def main(inp, route_x, loc_x, out_csv, meta_json=None):
    import json
    ref = Ref(route_x, loc_x)
    meta = json.load(open(meta_json, encoding="utf-8")) if meta_json else {}
    warnings = []
    if inp.lower().endswith(".xlsx"):
        src, warnings = read_notice_xlsx(inp)
    else:
        src = pd.read_csv(inp, dtype=str, keep_default_na=False, encoding="utf-8-sig")
        src["무정차없음"] = [True if (a == "" and b == "") else None for a, b in zip(src["무정차정류소"], src["정류소ID"])]
        src["무정차없음"] = src["무정차없음"].astype(object)
        src["_원본순번"] = src["정류소순번"]
    for c in ("PDF쪽", "시작시각", "종료시각"):
        if c not in src: src[c] = ""
    if inp.lower().endswith(".xlsx"):
        # 첨부 xlsx에는 방향·시각·우회 경로가 없다 → 정류소 ID가 어느 쪽인지 정하므로 방향은 비우고 근거만 적는다
        src["방향근거"] = src["방향근거"].where(src["방향근거"] != "", "공지 ID로 특정(방향 표기 없음)")
        src["운수사"] = src["비고"].str.extract(r"시트:([^,\s]+)", expand=False).fillna("")
    for k, v in meta.items():
        src[k] = v
    df = finalize(verify(src, ref), ref)
    if inp.lower().endswith(".xlsx"):   # JTBC 파일과 같은 표기로 맞춤
        df["무정차정류소"] = [re.sub(r"\(\d{4,8}\)$", "", re.sub(r"^\d+\.", "", str(x).strip())).strip() for x in df["무정차정류소"]]
        df["확인상태"] = df["확인상태"].replace({"확인됨": "확인", "비고칸 해석": "확인 필요"})
    if "종료시각구분" not in df:
        df["종료시각구분"] = ["지정" if str(v) else "" for v in df["종료시각"]]
    for c in COLS:
        if c not in df: df[c] = ""
    df = df[COLS].fillna("")
    for c in ID_COLS: df[c] = df[c].astype(str)
    df.to_csv(out_csv, index=False, encoding="utf-8-sig")
    vc = df["매칭결과"].value_counts()
    lines = [f"행 수: {len(df)}", f"노선 수: {df['노선번호'].nunique()}", "매칭결과별:"] + [f"  {k}: {v}" for k, v in vc.items()]
    need = df[~df["매칭결과"].isin(["일치", "순번 보완", "무정차 없음(우회만)"]) | df["확인상태"].isin(["확인필요", "비고칸 해석"])]
    lines.append(f"사람이 확인할 행: {len(need)}")
    for _, r in need.iterrows():
        lines.append(f"  [{r['노선번호']}] {r['무정차정류소']} {r['정류소ID']} → {r['매칭결과']} / {r['확인상태']} / {r['비고']}")
    lines += [f"경고: {w}" for w in warnings]
    open(re.sub(r"\.csv$", "", out_csv) + ".summary.txt", "w", encoding="utf-8").write("\n".join(lines))
    print("\n".join(lines))


if __name__ == "__main__":
    main(*sys.argv[1:6])

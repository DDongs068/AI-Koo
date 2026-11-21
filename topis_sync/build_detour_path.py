"""우회경로.csv 생성: 공지 '우회' 글을 지점 순서대로 펼치고, 노선 데이터의 정류소 이름(또는 공지에 적힌 ID)과 정확히 맞는 것만 ID를 붙인다.
나머지는 정류소 없이 지나가는 도로·교차로(무정차 통과)로 적는다.

사용: python -I build_detour_path.py active.csv 노선별정류소.xlsx 정류소위치.xlsx 출력.csv
"""
import re
import sys

import pandas as pd

sys.path.insert(0, ".")
from verify import Ref, norm_id, norm_name  # noqa: E402

# 지점 사이를 잇는 기호 (괄호 밖에서만 자른다)
ARROWS = r"→|↔|⇄|⟺|⇔|⇒|▷|▶|▸|➔|➝|\s*[-–=]+>\s*|\s>\s|\s+[-–]\s+|~|\s+또는\s+"
ROLE = re.compile(r"\((?:시작|경유|종료|왕복|기점|종점)\)")
PATH_MARK = re.compile(r"[①②③④⑤⑥⑦⑧⑨⑩]")
ACTION = re.compile(r"U\s*턴|유턴|회차|복귀")
MARKER = re.compile(r"^\s*[\[(]?\s*(무정차|우회|우회운행|운행|정차|무정차\s*통과)\s*[\])]?\s*$")
ROAD = re.compile(r"(대로|[0-9]*로|길)$")
FACIL = re.compile(r"(교차로|사거리|삼거리|오거리|터널|IC|JC|교|고가|지하차도|입구|광장|앞)$")
LEAD_PAREN = re.compile(r"^\s*\(([^()]*)\)\s*(?=\S)")


def split_top(s, pattern):
    """괄호·대괄호 안은 건드리지 않고 pattern으로 자른다."""
    out, depth, buf, i = [], 0, "", 0
    rx = re.compile(pattern)
    while i < len(s):
        ch = s[i]
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth = max(0, depth - 1)
        if depth == 0:
            m = rx.match(s, i)
            if m and m.end() > i:
                out.append(buf)
                buf, i = "", m.end()
                continue
        buf += ch
        i += 1
    out.append(buf)
    return [x.strip() for x in out if x.strip()]


def pick_direction(text, direction):
    """'공항방향: ... / 시내방향: ...' 형태면 그 행의 방향에 맞는 쪽만."""
    labels = list(re.finditer(r"([^/:：\s][^/:：]*?방향)\s*[:：]", text))
    if not labels:
        return text, ""
    segs = []
    for i, m in enumerate(labels):
        end = labels[i + 1].start() if i + 1 < len(labels) else len(text)
        segs.append((m.group(1).strip(), text[m.end():end].strip(" /")))
    d = norm_name(direction)
    for lab, body in segs:
        nl = norm_name(lab)
        if nl == d or nl in d or d in nl:
            return body, ""
    return text, "방향 라벨이 맞지 않아 우회 글 전체 사용"


def split_paths(text):
    """한 칸에 경로가 여러 개면(① ② ③ 또는 '/') 따로 자른다. 경로마다 (라벨, 지점 목록)."""
    t = PATH_MARK.sub("/", text)
    parts = split_top(t, r"\s*/\s*")
    paths = []
    for p in parts:
        p = re.sub(r"^\s*\d+\.\s*", "", p)          # '1. 잠실대교…'
        label = ""
        notes = []
        for m0 in re.finditer(r"\(([^()]*미경유[^()]*)\)", p):          # '(월드컵경기장, 마포구청 미경유)' → 지나가지 않는 곳
            notes.append(f"공지: {m0.group(1).strip()} (우회 경로가 지나지 않는 곳)")
        p = re.sub(r"\([^()]*미경유[^()]*\)", "", p).strip()
        m = LEAD_PAREN.match(p)
        if m and ("방향" in m.group(1) or m.group(1) in ("상행", "하행", "양방향", "내선", "외선")):
            label, p = m.group(1), p[m.end():]
        p = re.sub(r"\(경유\)", " → §경유§", p)                 # '(경유)B'는 '경유' 표시를 B에 붙여 둠
        p = ROLE.sub(" → ", p) if ROLE.search(p) else p      # '(시작)A (경유)B (종료)C'
        toks = split_top(p, ARROWS)
        # 하이픈이 공백 없이 한글 사이에 있는 경우: '삼성역-종합운동장'
        toks2 = []
        for t0 in toks:
            toks2 += split_top(re.sub(r"(?<=[가-힣])\s*[-–]\s*(?=[가-힣])", " → ", t0), ARROWS)
        # 쉼표로 이어진 도로·지점
        toks3 = []
        for t0 in toks2:
            toks3 += split_top(t0, r",\s*")
        # '…에서 U턴', '… 회차', '유턴하여 면목동' 처럼 지점과 동작이 붙은 것을 나눔
        toks4 = []
        for t0 in toks3:
            for q in re.split(r"\s*에서\s*(?=U\s*턴|유턴|회차)", t0):
                q = q.strip()
                if not q:
                    continue
                m = re.match(r"^(.*?\S)\s+(회차|유턴.*|U\s*턴.*)$", q)
                if m and not ACTION.search(m.group(1)):
                    toks4 += [m.group(1), m.group(2)]
                else:
                    m2 = re.match(r"^((?:U\s*턴|유턴)하여)\s+(\S.*)$", q)
                    toks4 += [m2.group(1), m2.group(2)] if m2 else [q]
        keep = []
        for t0 in toks4:                                   # 괄호 밖의 '○○ 미경유'
            if re.search(r"미\s*경유\s*\)?$", t0):
                notes.append(f"공지: {t0} (우회 경로가 지나지 않는 곳)")
            else:
                keep.append(t0)
        paths.append((label, keep, notes))
    return paths


def explode(tok):
    """'제기동역 (연세대, 안국역 경유)' → 괄호 안 경유지를 앞에 놓고 (본 지점) 반환. 반환: [(이름, 괄호내용, 경유지여부)]"""
    m = re.search(r"\(([^()]*)\)\s*$", tok)
    if m and "경유" in m.group(1) and ("," in m.group(1) or "·" in m.group(1)):
        main = tok[:m.start()].strip()
        vias = [re.sub(r"\s*경유\s*", "", v).strip() for v in re.split(r"[,·]", m.group(1))]
        return [(v, "", True) for v in vias if v] + [(main, "", False)]
    return [(tok, "", False)]


def clean_name(t):
    """지점 이름만 남기고 (괄호 내용, 접미 표현)은 따로."""
    paren = " ".join(re.findall(r"\(([^()]*)\)", t))
    base = re.sub(r"\([^()]*\)", "", t)
    base = re.sub(r"[\[\]]", "", base)
    base = re.sub(r"\s*(우회|진입|이동|통행)[^,]*$", "", base)
    base = re.sub(r"\s*(경유|운행|정차|인근|에서|미경유)\s*$", "", base)
    base = base.strip(" :：")
    if base.endswith("로로"):
        base = base[:-1]
    elif re.search(r"(거리|역|널|입구|앞|IC|광장|동|대교|교)로$", base):
        base = base[:-1]
    elif base.endswith("으로") and len(base) > 3:
        base = base[:-2]
    return base.strip(), paren.strip()


def main(active_csv, route_x, loc_x, out_csv):
    ref = Ref(route_x, loc_x)
    loc_names = {}
    for ars, z in ref.loc.iterrows():
        loc_names.setdefault(norm_name(z["정류소명"]), []).append(dict(ARS_ID=ars, 정류소명=z["정류소명"], X좌표=z["X좌표"], Y좌표=z["Y좌표"]))
    d = pd.read_csv(active_csv, dtype=str, encoding="utf-8-sig").fillna("")
    key = ["노선번호", "방향", "시작시각", "종료시각", "우회"]
    rows = []
    stat = dict(paths=0, tokens=0, stop=0, road=0, facil=0, spot=0, act=0, omit=0, marker=0, byid=0, nostop_hit=0)
    for k, g in d.groupby(key, sort=False):
        rt, direction, st, en, text = k
        rn, _ = ref.resolve_route(rt)
        seg, seg_note = pick_direction(text, direction)
        names, ids = {}, {}
        if rn:
            for _, z in ref.by_route[rn].iterrows():
                names.setdefault(norm_name(z["정류소명"]), []).append(z)
                ids[norm_id(z["ARS_ID"])] = z
        blocked = set(g["ARS_ID_노선데이터"]) | set(g["정류소ID"])
        gr = d[(d["노선번호"] == rt) & (d["시작시각"] == st)]          # 같은 공지(노선·시각)의 양쪽 방향 무정차 목록
        blocked_notice = set(gr["ARS_ID_노선데이터"]) | set(gr["정류소ID"])
        seqs = sorted(int(x) for x in g["정류소순번"] if str(x).isdigit())
        center = seqs[len(seqs) // 2] if seqs else None
        first = g.iloc[0]
        for pno, (label, toks, pnotes) in enumerate(split_paths(seg), 1):
            if not toks:
                continue
            stat["paths"] += 1
            order = 0
            expanded = []
            for t in toks:
                expanded += explode(t)
            for t0, _, via in expanded:
                order += 1
                stat["tokens"] += 1
                via_flag = via or t0.lstrip().startswith("§경유§") or bool(re.search(r"경유\s*\)?\s*$", t0))
                t0 = t0.replace("§경유§", "").strip()
                t, paren = clean_name(t0)
                note = [x for x in (seg_note, f"공지 방향표기: {label}" if label else "",
                                    "공지의 괄호 안 경유지" if via else "", *pnotes) if x]
                base = dict(공지ID=first["공지ID"], 노선번호=rt, 방향=direction, 시작시각=st, 종료시각=en,
                            종료시각구분=first.get("종료시각구분", ""), 우회일자=first["우회일자"],
                            경로번호=str(pno), 순서=order, 원문표기=t0, 지점이름=t, PDF쪽=first["PDF쪽"],
                            정류소ID="", 정류소명_노선데이터="", X좌표="", Y좌표="", 정차여부="", 지점유형="", 비고="")
                if MARKER.match(t0.strip(" :：")):
                    base.update(지점유형="구간표시", 지점이름=t0.strip(), 비고="; ".join(note))
                    stat["marker"] += 1
                elif not t or set(t) <= set("….·"):
                    base.update(지점유형="생략", 비고="; ".join(note + ["원래 노선과 같은 구간(공지에서 생략)"]))
                    stat["omit"] += 1
                elif MARKER.match(t0) or MARKER.match(t):
                    base.update(지점유형="구간표시", 비고="; ".join(note))
                    stat["marker"] += 1
                elif ACTION.search(t):
                    base.update(지점유형="동작", 비고="; ".join(note + ([f"괄호: {paren}"] if paren else [])))
                    stat["act"] += 1
                else:
                    z, how, loose_used = None, "", False
                    numq = re.search(r"\(\s*\d+\s*번\s*\)", t0)       # '여의도환승센터(3번)' — 번호로 구분되는 정류소라 이름만으로는 못 고름
                    pid = [norm_id(x) for x in re.findall(r"\b(\d{5}|\d{2}-\d{3})\b", paren + " " + t0)]
                    pid = [x for x in pid if x in ids]
                    if numq and not pid:
                        pass
                    elif pid:
                        z, how = ids[pid[0]], "공지에 적힌 ID"
                    else:
                        cand = names.get(norm_name(t), [])
                        if not cand:  # 같은 공지 무정차 목록의 정류소와 '역' 글자만 다른 경우 (동대문.흥인지문 ↔ 동대문역.흥인지문)
                            loose = [z0 for nm, zs in names.items() for z0 in zs
                                     if nm.replace("역", "") == norm_name(t).replace("역", "") and norm_id(z0["ARS_ID"]) in blocked_notice]
                            if len(loose) == 1:
                                cand, loose_used = loose, True
                        if len(cand) == 1:
                            z, how = cand[0], ("이름 일치('역' 글자만 다름, 같은 공지의 무정차 목록 정류소)" if loose_used else "이름 일치")
                        elif len(cand) > 1 and center is not None:
                            z = min(cand, key=lambda c: abs(int(c["순번"]) - center))
                            how = f"이름 일치(같은 이름 {len(cand)}곳 중 무정차 구간과 순번이 가까운 쪽)"
                    if numq and z is None:
                        note.append(f"괄호의 번호({numq.group(0)})로 구분되는 정류소라 ID를 연결하지 않음")
                    if z is not None:
                        sid = norm_id(z["ARS_ID"])
                        base.update(지점유형="정류소", 정류소ID=sid, 정류소명_노선데이터=z["정류소명"],
                                    X좌표=z["X좌표"], Y좌표=z["Y좌표"],
                                    정차여부="무정차" if sid in blocked_notice else "정차",
                                    비고="; ".join(note + [f"연결: {how}"]))
                        stat["stop"] += 1
                        stat["byid"] += how == "공지에 적힌 ID"
                        stat["nostop_hit"] += sid in blocked
                    else:
                        if ROAD.search(t):
                            typ = "도로"; stat["road"] += 1
                        elif FACIL.search(t):
                            typ = "교차로·시설"; stat["facil"] += 1
                        else:
                            typ = "장소(종류 미확인)"; stat["spot"] += 1
                        n = norm_name(t)
                        near = [kk for kk in names if len(n) >= 3 and (n in kk or kk in n)]
                        if near:
                            cs = "; ".join(sorted({names[kk][0]["정류소명"] for kk in near})[:3])
                            note.append(f"이름이 비슷한 정류소 있음(ID 연결 안 함): {cs}")
                        if paren:
                            note.append(f"괄호: {paren}")
                        stop_flag = ""
                        if via_flag and typ == "장소(종류 미확인)":
                            # 공지에 '경유'라고 적힌 장소 → 서는 곳. 정류소 위치 파일에서 같은 이름을 찾아 ID·좌표를 붙임(1곳일 때만)
                            hits = loc_names.get(norm_name(t), [])
                            if len(hits) == 1:
                                h = hits[0]
                                base.update(정류소ID=h["ARS_ID"], 정류소명_노선데이터=h["정류소명"], X좌표=h["X좌표"], Y좌표=h["Y좌표"])
                                note.append("경유 표기 → 정차. 정류소 위치 파일의 같은 이름 정류소 1곳에 연결(이 노선 데이터에는 없음)")
                            elif len(hits) > 1:
                                note.append("경유 표기 → 정차. 같은 이름 정류소가 위치 파일에 여러 곳이라 ID 못 정함: "
                                            + "; ".join(f"{h['정류소명']}({h['ARS_ID']})" for h in hits[:4]))
                            else:
                                note.append("경유 표기 → 정차. 정류소 위치 파일에 같은 이름이 없어 ID 못 찾음")
                            stop_flag = "정차"
                            typ = "정류소(경유)"
                        base.update(지점유형=typ, 정차여부=stop_flag or "통과", 비고="; ".join(note))
                rows.append(base)
    cols = ["공지ID", "노선번호", "방향", "시작시각", "종료시각", "종료시각구분", "우회일자", "경로번호", "순서", "원문표기", "지점이름",
            "PDF쪽", "정류소ID", "정류소명_노선데이터", "X좌표", "Y좌표", "정차여부", "지점유형", "비고"]
    out = pd.DataFrame(rows, columns=cols) if rows else pd.DataFrame(columns=cols)   # 우회 글이 없는 공지는 빈 파일
    out.to_csv(out_csv, index=False, encoding="utf-8-sig")
    print(stat)
    if len(out):
        print(out.지점유형.value_counts().to_dict())
    return out


if __name__ == "__main__":
    main(*sys.argv[1:5])

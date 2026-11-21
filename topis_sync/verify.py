"""검증·보완 단계: 추출된 무정차 행을 노선별 정류소/정류소 위치 xlsx와 대조해 매칭결과를 채운다.

입력 행(dict/DataFrame)에 필요한 열: 노선번호, 무정차정류소(공지상 이름), 정류소ID(공지상, 없으면 빈칸),
선택: 방향, 정류소순번(공지상 순번이 있을 때만), 무정차없음(True면 우회만 행)
매칭결과: 일치 / ID 불일치 / 순번 보완 / 노선 없음 / 정류장 데이터에 없음 / 무정차 없음(우회만)
          + 확인필요(후보가 여러 개라 좁히지 못함. 지도 쪽은 쓰지 않는 값)
"""
import re
import pandas as pd

ALIAS_FILE_DEFAULT = None  # 노선명 대응표 csv (공지상 노선, 데이터상 노선)
BUILTIN_ALIAS = {"110A": "110A고려대", "110B": "110B국민대"}


def norm_id(v):
    """ID는 항상 문자열. 5자리 ARS면 0 채움, '19-133' 형태는 '19133'."""
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    s = re.sub(r"[\s\-]", "", str(v))
    if s in ("", "nan", "None"):
        return ""
    return s.zfill(5) if s.isdigit() and len(s) < 5 else s


def norm_name(s):
    s = re.sub(r"\([^)]*\)", "", str(s))          # (가상), (14204) 등 제거
    s = re.sub(r"^\d+\.", "", s.strip())          # '1.양천공영차고지'
    return re.sub(r"[\s·.\-]", "", s)


class Ref:
    def __init__(self, route_xlsx, loc_xlsx, alias_csv=None):
        r = pd.read_excel(route_xlsx, dtype=str)
        r["ARS_ID"] = r["ARS_ID"].map(norm_id)
        r["순번"] = r["순번"].astype(int)
        self.routes = r
        self.by_route = {k: g.sort_values("순번") for k, g in r.groupby("노선명")}
        loc = pd.read_excel(loc_xlsx, dtype=str)
        loc["ARS_ID"] = loc["ARS_ID"].map(norm_id)
        self.loc = loc.drop_duplicates("ARS_ID").set_index("ARS_ID")
        self.alias = dict(BUILTIN_ALIAS)
        if alias_csv:
            a = pd.read_csv(alias_csv, dtype=str)
            self.alias.update(dict(zip(a.iloc[:, 0], a.iloc[:, 1])))

    def resolve_route(self, name):
        """(데이터상 노선명, 방법) 또는 (None, '')"""
        name = str(name).strip()
        if name in self.by_route:
            return name, "동일"
        if name in self.alias and self.alias[name] in self.by_route:
            return self.alias[name], "대응표"
        # 접두 일치가 정확히 1개일 때만 (110A → 110A고려대)
        cand = [k for k in self.by_route if k.startswith(name) and not k[len(name):len(name)+1].isdigit()]
        if len(cand) == 1:
            return cand[0], "접두일치(추정)"
        return None, ""


def _fill_from_stop(out, st):
    out["NODE_ID"] = st["NODE_ID"]
    out["ARS_ID_노선데이터"] = st["ARS_ID"]
    out["정류소명_노선데이터"] = st["정류소명"]
    out["정류소순번"] = str(st["순번"])
    out["X좌표"], out["Y좌표"] = st["X좌표(경도)"] if "X좌표(경도)" in st else st["X좌표"], \
        st["Y좌표(위도)"] if "Y좌표(위도)" in st else st["Y좌표"]


def verify_row(row, ref):
    out = dict(row)
    for c in ["NODE_ID", "ARS_ID_노선데이터", "정류소명_노선데이터", "X좌표", "Y좌표", "매칭결과"]:
        out.setdefault(c, "")
    notes = [out.get("비고", "")] if out.get("비고") else []
    rid = norm_id(row.get("정류소ID"))
    name = row.get("무정차정류소", "")
    given_seq = str(row.get("정류소순번", "") or "")
    out["ID출처"] = out.get("ID출처", "") or ("공지" if rid else "")

    route, how = ref.resolve_route(row["노선번호"])
    if row.get("무정차없음") is True:
        if route is None:   # 노선 데이터에 없는 노선(예: 시티투어버스)은 우회만보다 노선 없음이 먼저
            out["매칭결과"] = "노선 없음"
            notes.append("무정차 정류소 기재 없음. 노선 데이터에도 없음")
            out["확인상태"] = out.get("확인상태") or "확인필요"
        else:
            out["매칭결과"] = "무정차 없음(우회만)"
            out["확인상태"] = out.get("확인상태") or "확인됨"
        out["비고"] = " / ".join(n for n in notes if n)
        return out

    if how == "접두일치(추정)":
        notes.append(f"노선명 추정 매칭: {route}")
    if how in ("대응표", "접두일치(추정)"):
        out["노선명_노선데이터"] = route
    g = ref.by_route.get(route) if route else None

    def from_loc(i):  # 위치 파일로 좌표만 보완
        if i in ref.loc.index:
            h = ref.loc.loc[i]
            out["NODE_ID"], out["X좌표"], out["Y좌표"] = h["NODE_ID"], h["X좌표"], h["Y좌표"]
            out["정류소명_노선데이터"] = out["정류소명_노선데이터"] or ""
            return h
        return None

    if g is None:
        out["매칭결과"] = "노선 없음"
        if rid and from_loc(rid) is not None:
            out["정류소ID"] = rid
            notes.append("좌표는 정류소 위치 파일 기준(노선 데이터 없음)")
        out["확인상태"] = "확인필요"
    else:
        hits = g[g["ARS_ID"] == rid] if rid else g.iloc[0:0]
        if len(hits):
            if len(hits) > 1:
                if given_seq and (hits["순번"].astype(str) == given_seq).any():
                    hits = hits[hits["순번"].astype(str) == given_seq]
                else:
                    notes.append(f"노선 내 같은 ID {len(hits)}회 등장(순번 {','.join(hits['순번'].astype(str))}), 첫 번째 사용")
            _fill_from_stop(out, hits.iloc[0])
            out["정류소ID"] = rid
            out["매칭결과"] = "일치"
            out["확인상태"] = out.get("확인상태") or "확인됨"
        else:
            nm = norm_name(name)
            cand = g[g["정류소명"].map(norm_name) == nm] if nm else g.iloc[0:0]
            partial = False
            if not len(cand) and nm:
                partial = True
                cand = g[g["정류소명"].map(norm_name).str.contains(re.escape(nm), regex=True)]
            if len(cand) > 1 and given_seq:
                c2 = cand[cand["순번"].astype(str) == given_seq]
                cand = c2 if len(c2) else cand
            if len(cand) == 1 and partial:
                # 이름 일부만 겹침: 지도에서 바로 쓰지 않도록 확인필요로 남기고 후보를 보여줌
                out["매칭결과"] = "확인필요"
                out["확인상태"] = "확인필요"
                notes.append(f"부분 일치 후보 1개: {cand.iloc[0]['정류소명']}({cand.iloc[0]['ARS_ID']})#{cand.iloc[0]['순번']}")
            elif len(cand) == 1:
                _fill_from_stop(out, cand.iloc[0])
                out["ID출처"] = "이름매칭(노선내)"
                if rid and rid != cand.iloc[0]["ARS_ID"]:
                    out["매칭결과"] = "ID 불일치"
                    notes.append(f"공지 ID {rid} ≠ 노선데이터 ID {cand.iloc[0]['ARS_ID']}")
                    out["확인상태"] = "확인필요"
                else:
                    out["정류소ID"] = cand.iloc[0]["ARS_ID"]
                    out["매칭결과"] = "순번 보완"
                    out["확인상태"] = "이름매칭(추정)"
                    notes.append("이름으로 노선 내 정류소를 찾음")
            elif len(cand) > 1:
                out["매칭결과"] = "확인필요"
                out["확인상태"] = "확인필요"
                notes.append("후보 %d개: %s" % (len(cand), ",".join(f"{a}#{s}" for a, s in zip(cand["ARS_ID"], cand["순번"]))))
            else:
                # 노선에 없음: 위치 파일에 ID가 있나?
                h = from_loc(rid) if rid else None
                if h is not None:
                    out["정류소ID"] = rid
                    out["매칭결과"] = "정류장 데이터에 없음"   # 팀 기준: 이 노선 정류소 목록에 없으면 이 값 (6200 잠실르엘)
                    out["확인상태"] = "확인필요"
                    notes.append(f"ID는 위치 파일에 있으나({h['정류소명']}) 이 노선 정류소 목록에는 없음")
                else:
                    out["매칭결과"] = "정류장 데이터에 없음"
                    out["확인상태"] = "확인필요"
    out["비고"] = " / ".join(n for n in notes if n)
    return out


def verify(df, ref):
    return pd.DataFrame([verify_row(r, ref) for r in df.to_dict("records")])


INFERRED_DIR = ("화살표 추정", "양방향 분리")   # 공지에 방향이 직접 적히지 않아 우리가 정한 방향
SAFE = ("일치", "순번 보완")


def finalize(df, ref):
    """길찾기 코드는 매칭결과를 안 보고 순번만 본다 → 안전하지 않은 행은 정류소순번을 비워서 넘긴다.
    1) 매칭결과가 일치·순번 보완이 아닌 행: 순번 비움
    2) 방향이 추정이고 ID를 우리가 채웠는데 같은 노선에 같은 이름 정류소가 반대편에도 있는 행: 순번 비움(반대편 순번을 잘못 고를 수 있음)"""
    df = df.copy()
    df["순번비움사유"] = ""
    blk = df.groupby(["노선번호", "PDF쪽", "시작시각"])["ARS_ID_노선데이터"].agg(set).to_dict()
    for i, r in df.iterrows():
        why = ""
        if r["매칭결과"] not in SAFE:
            why = "매칭결과가 일치·순번 보완이 아님"
        elif r.get("방향근거", "") in INFERRED_DIR and r["정류소순번"] != "" and r.get("ID출처", "") not in ("PDF", "공지", "공지(xlsx)"):   # 공지에 ID가 직접 있으면 어느 쪽인지 ID가 정함
            route = r.get("노선명_노선데이터") or r["노선번호"]
            g = ref.by_route.get(route)
            if g is not None:
                me = norm_name(r["정류소명_노선데이터"] or r["무정차정류소"])
                same = g[(g["정류소명"].map(norm_name) == me) & (g["ARS_ID"] != r["ARS_ID_노선데이터"])]
                block_ids = blk.get((r["노선번호"], r["PDF쪽"], r["시작시각"]), set())
                # 반대편 정류소도 같은 공지 블록에서 무정차면 어느 쪽을 골라도 결과가 같으므로 비우지 않음
                if len(same) and not (set(same["ARS_ID"]) & block_ids):
                    why = "방향 추정 + 같은 이름 정류소가 반대편에도 있음(ID %s)" % ",".join(same["ARS_ID"])
        if why:
            df.at[i, "순번비움사유"] = why
            df.at[i, "정류소순번"] = ""
            df.at[i, "비고"] = (str(r["비고"]) + " / " if r["비고"] else "") + "순번 비움: " + why
    return df

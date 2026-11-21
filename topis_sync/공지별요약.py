"""처리된 공지를 하나씩 보여준다(어떤 공지가 몇 행을 만들었는지). 사용: python 공지별요약.py   결과는 화면 + data/merged/공지별요약.txt"""
import json
import os
import sys

import pandas as pd

data = sys.argv[1] if len(sys.argv) > 1 else "data"
d = os.path.join(data, "merged")
rd = lambda n: pd.read_csv(os.path.join(d, n), dtype=str, encoding="utf-8-sig").fillna("")
a, h, p = rd("topis_v1_active.csv"), rd("topis_v1_hold.csv"), rd("topis_v1_우회경로.csv")
led = json.load(open(os.path.join(data, "ledger.json"), encoding="utf-8"))
ok = {k: v for k, v in led.items() if v.get("status") == "처리됨" and not v.get("canceled")}
bad = {k: v for k, v in led.items() if str(v.get("status", "")).startswith("처리 못 함")}
merged_into = {}                                   # 같은 내용이라 다른 공지에 합쳐진 공지 → 남은 공지
for df in (a, h):
    for nid, note in zip(df["공지ID"], df["비고"]):
        if "동일 내용 공지 병합:" in note:
            for x in note.split("동일 내용 공지 병합:")[1].split("/")[0].replace(" ", "").split(","):
                if x and x != nid:
                    merged_into[x] = nid
out = [f"처리된 공지 {len(ok)}건 | topis_v1_active {len(a)}행, hold {len(h)}행, 우회경로 {len(p)}행", ""]
for i in sorted(ok, key=int, reverse=True):
    ai, hi, pi = a[a["공지ID"] == i], h[h["공지ID"] == i], p[p["공지ID"] == i]
    out.append(f"[{i}] {ok[i]['title'][:48]}")
    if i in merged_into:
        out.append(f"     같은 내용이라 [{merged_into[i]}] 공지에 합쳐짐 (이 공지 몫의 행은 따로 없음)")
    else:
        extra = ""
        out.append(f"     날짜 {ok[i].get('event_start', '')} | active {len(ai)}행(노선 {ai['노선번호'].nunique()}개) | hold {len(hi)}행 | 우회경로 {len(pi)}행")
if bad:
    out += ["", f"처리 못 한 공지 {len(bad)}건 (csv에 들어가지 않음)"]
    out += [f"[{i}] {v['title'][:48]}" for i, v in sorted(bad.items(), reverse=True)]
text = "\n".join(out)
print(text)
open(os.path.join(d, "공지별요약.txt"), "w", encoding="utf-8").write(text)

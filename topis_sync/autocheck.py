"""자동 검사: 노선 데이터에서 채운 행(ID근거=노선데이터 대조)이 PDF 원문과 맞는지 스크립트로 확인.
 A 구간 양 끝 이름이 PDF 쪽 본문에 있는가  B 순번이 끊기지 않고 이어지는가  C 공지상정류소수와 블록 행 수가 같은가
 D PDF 출처 ID가 PDF 쪽 본문에 있는가"""
import re, sys, pandas as pd
sys.path.insert(0, '.')
from verify import norm_name

def run(csv, pdf_txt):
    d = pd.read_csv(csv, dtype=str, keep_default_na=False)
    pages = open(pdf_txt, encoding='utf-8').read().split('\f')
    npg = [re.sub(r"[\s·.\-()]", "", p) for p in pages]
    d['_seq'] = pd.to_numeric(d['정류소순번'], errors='coerce')
    res = []
    for key, g in d.groupby(['노선번호', '방향', '시작시각', 'PDF쪽'], sort=False):
        pg = npg[int(key[3]) - 1]
        for idx, r in g.iterrows():
            flags = []
            if r.ID출처 == 'PDF':
                i = r.정류소ID
                if not re.search(i[:2] + i[2:], pg.replace('-', '')): flags.append('D:ID가 쪽에 없음')
        gg = g[g.ID출처 == '노선데이터 대조']
        if len(gg) >= 2:
            ends = [gg.iloc[0], gg.iloc[-1]]
            for e in ends:
                n = norm_name(e.정류소명_노선데이터 or e.무정차정류소)
                if n not in pg and n[:4] not in pg:
                    for ix in gg.index: res.append((ix, 'A:구간 끝 이름이 쪽에 없음'))
                    break
            s = gg['_seq'].dropna().astype(int).tolist()
            if s and (max(s) - min(s) + 1 != len(set(s)) and sorted(s) != s and sorted(s, reverse=True) != s):
                for ix in gg.index: res.append((ix, 'B:순번이 끊김'))
        for idx, r in g.iterrows():
            if r.ID출처 == 'PDF':
                i = r.정류소ID
                if not re.search(i, pg): res.append((idx, 'D:PDF 출처 ID가 쪽에 없음'))
    blk = d[d.공지상정류소수 != ''].groupby(['노선번호', '시작시각', '종료시각', 'PDF쪽'])
    for k, g in blk:
        if len(g) != int(g.공지상정류소수.iloc[0]):
            for ix in g.index: res.append((ix, f'C:공지 {g.공지상정류소수.iloc[0]}개 vs 행 {len(g)}개'))
    f = pd.DataFrame(res, columns=['idx', '사유']).drop_duplicates()
    return d, f

if __name__ == '__main__':
    d, f = run(sys.argv[1], sys.argv[2])
    print('전체', len(d), '행 / 걸린 행', f.idx.nunique())
    print(f.사유.str[:1].value_counts().to_dict())
    src = d['ID출처'].value_counts().to_dict(); print(src)
    bad = set(f.idx); d['보류'] = d.index.isin(bad)
    print(d.groupby('ID출처').보류.agg(['sum', 'size']))
    print('노선별 보류 상위', d[d.보류].groupby('노선번호').size().sort_values(ascending=False).head(10).to_dict())
    d.to_pickle('/tmp/auto.pkl'); f.to_pickle('/tmp/autof.pkl')

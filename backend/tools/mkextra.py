import json,sqlite3,os,re,sys
eng,db,pdir=sys.argv[1:4]
d=json.load(open(f'{eng}/data/cityflow-data.json'))
ev={e[0] for k in d['scen'] for e in d['scen'][k]['events']}
paths={}
for f in os.listdir(pdir):
    m=re.match(r'path(.*)\.json$',f)
    if m: paths[re.sub(r'#U([0-9a-f]{4})',lambda x:chr(int(x.group(1),16)),m.group(1))]=os.path.join(pdir,f)
c=sqlite3.connect(db); by={}
for rid,nm,seq,ars,name,lng,lat in c.execute('select route_id,route_name,seq,ars_id,name,lng,lat from route_stops order by route_id,seq'):
    by.setdefault(nm,{}).setdefault(rid,[]).append((seq,ars,name,lng,lat))
out={};nopath=0;night=[];skipEv=sorted(n for n in by if n in ev and n not in d['routes'])
for nm,ids in by.items():
    if nm in d['routes'] or nm in ev: continue
    if re.match(r'^N\d',nm) or '새벽' in nm or '심야' in nm: night.append(nm); continue
    rid,rows=max(ids.items(),key=lambda kv:len(kv[1]))
    st=[{'seq':s,'ars':(a.zfill(5) if a.isdigit() else a),'name':n,'lat':la,'lon':lo} for s,a,n,lo,la in rows if la and lo and 33<la<39]
    if len(st)<2: continue
    r={'no':nm,'routeId':rid,'stops':st}
    if nm in paths: r['path']=json.load(open(paths[nm]))
    else: nopath+=1
    out[nm]=r
json.dump({'meta':{'note':'통제 공지에 없는 노선(통제 영향 없음). 공지가 있는데 우회 설정이 없는 노선은 제외','excludedWithNotice':skipEv,'noPath':nopath,'excludedNight':night},'routes':out},open(f'{eng}/data/extra-routes.json','w'),ensure_ascii=False,separators=(',',':'))
print(len(out),'routes; nopath',nopath,'excluded',len(skipEv), 'paths decoded',len(paths), list(paths)[:3])

/* CITYFLOW core — DOM·지도 없음. 브라우저(<script>)·node 공용.
 * 노출: window.CityflowCore = {Engine, CityFlow, NetBuild, PARAMS, createPlanner}
 */
(function(root){
// ===== 우회 반영 경로탐색 엔진 (DOM 없음: 브라우저·node 공용) =====
const Engine = (() => {
  const R = 6371000, rad = Math.PI/180;
  const P = a => ({lat:a[0], lon:a[1]});
  function dist(a, b){ const x = (b.lon-a.lon)*rad*Math.cos((a.lat+b.lat)/2*rad), y = (b.lat-a.lat)*rad; return Math.hypot(x, y)*R; }
  function bearing(a, b){ const y = Math.sin((b.lon-a.lon)*rad)*Math.cos(b.lat*rad), x = Math.cos(a.lat*rad)*Math.sin(b.lat*rad)-Math.sin(a.lat*rad)*Math.cos(b.lat*rad)*Math.cos((b.lon-a.lon)*rad); return (Math.atan2(y, x)/rad+360)%360; }

  // ---------- 기존 지도 파일과 같은 기하 처리 ----------
  function cleanPath(pts){
    const out = [];
    for (const c of pts) {
      if (out.length && dist(P(out[out.length-1]), P(c)) < 0.3) continue;
      if (out.length >= 2) {
        const a = out[out.length-2], b = out[out.length-1];
        const v1 = [b[0]-a[0], b[1]-a[1]], v2 = [c[0]-b[0], c[1]-b[1]];
        if (v1[0]*v2[0] + v1[1]*v2[1]*0.63 < 0 && dist(P(b), P(c)) < 5) continue;
        if (v1[0]*v2[0] + v1[1]*v2[1]*0.63 < 0 && dist(P(a), P(b)) < 5) { out.pop(); }
      }
      out.push(c);
    }
    return out;
  }
  // 정류소를 경로에 순서대로 매칭(순서 유지 + 거리 합 최소)
  function matchStops(pts, STOPS){
    const n = pts.length, m = STOPS.length, back = [];
    let prev = new Float64Array(n).fill(0);
    for (let s = 0; s < m; s++) {
      const cur = new Float64Array(n), arg = new Int32Array(n);
      let bestV = Infinity, bestK = 0;
      for (let j = 0; j < n; j++) {
        if (prev[j] < bestV) { bestV = prev[j]; bestK = j; }
        cur[j] = bestV + dist(STOPS[s], P(pts[j])); arg[j] = bestK;
      }
      back.push(arg); prev = cur;
    }
    let j = 0; for (let k = 1; k < n; k++) if (prev[k] < prev[j]) j = k;
    const idx = {};
    for (let s = m-1; s >= 0; s--) { idx[STOPS[s].seq] = j; j = back[s][j]; }
    return idx;
  }
  function anchorIndex(pts, idx, a){
    if (a.seq) return idx[a.seq];
    let best = idx[a.range[0]], bd = Infinity;
    for (let j = idx[a.range[0]]; j <= idx[a.range[1]]; j++) { const d = dist(a, P(pts[j])); if (d < bd) { bd = d; best = j; } }
    return best;
  }
  function orderVias(list, o, dst){
    const chain = [];
    list.forEach(v => {
      let bi = 0, bc = Infinity;
      for (let i = 0; i <= chain.length; i++) { const a = i === 0 ? o : chain[i-1], b = chain[i] || dst; const c = dist(a, v) + dist(v, b) - dist(a, b); if (c < bc) { bc = c; bi = i; } }
      chain.splice(bi, 0, v);
    });
    return chain;
  }
  const lineKm = line => { let m = 0; for (let i = 1; i < line.length; i++) m += dist(P(line[i-1]), P(line[i])); return m/1000; };

  // ---------- 길찾기 (기존 파일과 동일: 카카오 → 실패 시 OSRM) ----------
  async function kakaoRoute(key, origin, angle, waypoints, dest, noAngle){
    const o = {x:origin.lon, y:origin.lat}; if (!noAngle) o.angle = Math.round(angle);
    const body = {origin:o, destination:{x:dest.lon, y:dest.lat}, waypoints: waypoints.map((w, i) => ({name:'w'+i, x:w.lon, y:w.lat})), priority:'RECOMMEND'};
    const r = await fetch('https://apis-navi.kakaomobility.com/v1/waypoints/directions', {method:'POST',
      headers:{'Authorization':'KakaoAK '+key, 'Content-Type':'application/json'}, body:JSON.stringify(body)});
    if (r.status === 400 && !noAngle) return kakaoRoute(key, origin, angle, waypoints, dest, true);
    if (!r.ok) throw new Error('카카오 HTTP '+r.status);
    const j = await r.json(); const rt = j.routes && j.routes[0];
    if (!rt || rt.result_code !== 0) throw new Error('카카오: '+(rt ? rt.result_msg : '응답 없음'));
    const line = [];
    rt.sections.forEach(sec => sec.roads.forEach(rd => { for (let k = 0; k < rd.vertexes.length; k += 2) line.push([rd.vertexes[k+1], rd.vertexes[k]]); }));
    return {line, km: rt.summary.distance/1000, engine:'카카오모빌리티'};
  }
  async function osrmPts(pts, useBearing){
    const coords = pts.map(p => p.lon.toFixed(6)+','+p.lat.toFixed(6)).join(';');
    let q = '?overview=full&geometries=geojson&continue_straight=false';
    if (useBearing) q += '&bearings='+pts.map(p => p.b || '').join(';');
    const r = await fetch('https://router.project-osrm.org/route/v1/driving/'+coords+q);
    if (!r.ok) throw new Error('OSRM HTTP '+r.status);
    const j = await r.json(); if (j.code !== 'Ok') throw new Error('OSRM '+j.code);
    return {line: j.routes[0].geometry.coordinates.map(c => [c[1], c[0]]), km: j.routes[0].distance/1000};
  }
  async function routeKakao(key, o, angle, wps, d){
    try { return await kakaoRoute(key, o, angle, wps, d); }
    catch(e) {
      const g = await osrmPts([Object.assign({}, o, {b: Math.round(angle)+',60'}), ...wps, d], true).catch(() => osrmPts([o, ...wps, d], false));
      g.engine = 'OSRM'; g.fallback = e.message; return g;
    }
  }
  const nz = a => String(a == null ? '' : a).replace(/^0+/, '');
  function legStops(RT, leg){
    const S = RT.borrow[leg.route].stops; let prev = 0;
    return leg.ars.map(a => { const s = S.find(x => nz(x.ars) === nz(a) && x.seq > prev); if (!s) throw new Error(leg.route+'번 정류소 '+a+' 없음'); prev = s.seq; return s; });
  }
  // 다른 노선의 연속 정류소로 우회 구간 만들기: 그 노선의 공식 도로 좌표가 있으면 정류소 사이를 잘라 쓰고(길찾기 호출 없음), 없을 때만 길찾기
  async function buildLegs(RT, gap, e, key){
    let line = [[e.o.lat, e.o.lon]], km = 0, engines = [];
    const conn = async (a, b) => { try { const g = await routeKakao(key, a, bearing(a, b), [], b); km += g.km; engines.push('연결로 '+g.engine); return g.line; } catch(err) { engines.push('연결로 길찾기 실패→직선'); return [[a.lat, a.lon], [b.lat, b.lon]]; } };
    for (const leg of gap.legs) {
      const B = RT.borrow[leg.route], st = legStops(RT, leg);
      if (B.path && !B.straight) {
        const idx = B.idx;
        let i0 = idx[st[0].seq], i1 = idx[st[st.length-1].seq];
        const near = (q, a, b) => { let bi = a, bd = Infinity; for (let j = Math.max(a, 0); j <= Math.min(b, B.path.length-1); j++) { const d = dist(q, P(B.path[j])); if (d < bd) { bd = d; bi = j; } } return bi; };
        if (leg.startAt) i0 = near(leg.startAt, i0-600, i0);
        if (leg.endAt) i1 = near(leg.endAt, i1, i1+600);
        const seg = B.path.slice(i0, i1+1);
        if (gap.connect) { const f = seg[0], a = line[line.length-1]; if (dist({lat:a[0],lon:a[1]}, {lat:f[0],lon:f[1]}) > 30) line = line.concat(await conn({lat:a[0],lon:a[1]}, {lat:f[0],lon:f[1]})); }
        line = line.concat(seg); km += lineKm(seg)/1000;
        engines.push(leg.route+'번 공식 경로');
      } else {
        const g = await routeKakao(key, st[0], bearing(st[0], st[1]), st.slice(1, -1), st[st.length-1]);
        line = line.concat(g.line); km += g.km;
        engines.push(leg.route+'번 정류소 '+st.length+'곳 경유 '+g.engine+(g.fallback ? '(카카오 실패: '+g.fallback+')' : ''));
      }
    }
    if (gap.connect) { const a = line[line.length-1]; if (dist({lat:a[0],lon:a[1]}, e.d) > 30) line = line.concat(await conn({lat:a[0],lon:a[1]}, e.d)); }
    line.push([e.d.lat, e.d.lon]);
    return {line, km, engine: engines.join(' + ')};
  }
  // 정상 경로 좌표만으로 우회선 만들기: {path:[A,B]} 정상 경로의 A→B(역방향 가능), {line:[...]} 지정 좌표, {kakao:[...]} 이 조각만 길찾기
  async function buildFromPath(gap, pts, idx, key){
    let line = [];
    for (const part of gap.pathParts) {
      if (part.kakao) { const k = part.kakao, g = await routeKakao(key, k[0], part.angle || 0, k.slice(1, -1), k[k.length-1]); line = line.concat(g.line); continue; }
      if (part.line) { line = line.concat(part.line.map(p => [p.lat, p.lon])); continue; }
      const a = anchorIndex(pts, idx, part.path[0]), b = anchorIndex(pts, idx, part.path[1]);
      line = line.concat(a <= b ? pts.slice(a, b+1) : pts.slice(b, a+1).reverse());
    }
    return {line, km: lineKm(line)/1000, engine:'정상 경로 좌표 재사용'};
  }

  // 노선 준비: 정상 경로 정리 + 정류소 매칭
  function prepRoute(RT){
    RT.stops.forEach(st => st.route = RT.no);
    if (!RT.path) { RT.path = RT.stops.map(st => [st.lat, st.lon]); RT.straight = true; }
    else RT.path = cleanPath(RT.path);
    RT.bySeq = Object.fromEntries(RT.stops.map(s => [s.seq, s]));
    RT.idx = RT.straight ? Object.fromEntries(RT.stops.map((st, i) => [st.seq, i])) : matchStops(RT.path, RT.stops);
    return RT;
  }
  // 우회 구간 선 계산 (기존 draw()의 빨간 선과 같은 방식). 결과: detours[d] = {line, stat:[...]}
  async function computeDetourLines(RT, key, onProgress){
    const path = RT.path, idx = RT.idx, out = [];
    for (const [d, dt] of RT.cfg.detours.entries()) {
      let line = [], cur = idx[dt.window[0]]; const stat = [];
      for (const [k, gap] of dt.gaps.entries()) {
        const f = anchorIndex(path, idx, gap.from), t = anchorIndex(path, idx, gap.to);
        const e = {o: P(path[f]), d: P(path[t])};
        line = line.concat(path.slice(cur, f+1));
        const angle = bearing(P(path[Math.max(f-4, 0)]), e.o);
        try {
          const vias = (gap.defVias || []).map(v => v.seq ? {lat:RT.bySeq[v.seq].lat, lon:RT.bySeq[v.seq].lon} : {lat:v.lat, lon:v.lon});
          const g = gap.legs ? await buildLegs(RT, gap, e, key) : gap.pathParts ? await buildFromPath(gap, path, idx, key) : await routeKakao(key, e.o, angle, orderVias(vias, e.o, e.d), e.d);
          line = line.concat(g.line);
          stat.push({ok:true, name:gap.name, engine:g.engine, km:g.km, fallback:g.fallback});
        } catch(err) {
          line = line.concat([[e.o.lat, e.o.lon], [e.d.lat, e.d.lon]]);
          stat.push({ok:false, name:gap.name, err:err.message});
        }
        cur = t; onProgress && onProgress(RT, d, k, stat[stat.length-1]);
      }
      line = line.concat(path.slice(cur, idx[dt.window[1]]+1));
      out.push({line, stat});
    }
    return out;
  }

  // ---------- 운행 형태(정상/우회)별 노선 모델 ----------
  // served: 정차 정류소 목록(순서대로), line: 주행 좌표, at[k]: served[k]의 line 인덱스, cumD/cumT: 누적 거리(m)/시간(분)
  const OFF_LINE_M = 600;
  const HWY = /\(가상\)|IC|JC|인천공항|영종|공항입구|북인천/;
  function buildVariant(RT, detLines, skipSet, P_){
    let line;
    if (!detLines) line = RT.path;
    else {
      const order = RT.cfg.detours.map((dt, d) => ({dt, d})).sort((a, b) => a.dt.window[0]-b.dt.window[0]);
      line = []; let cur = 0;
      order.forEach(({dt, d}) => { line = line.concat(RT.path.slice(cur, RT.idx[dt.window[0]])).concat(detLines[d].line); cur = RT.idx[dt.window[1]]+1; });
      line = line.concat(RT.path.slice(cur));
    }
    let served = RT.stops.filter(s => !skipSet.has(s.seq));
    const offLine = [];
    if (detLines) {   // 우회 선에서 OFF_LINE_M 넘게 떨어진 정류소는 우회 중 지나지 않음 → 억지로 맞추면 선이 튀고 시간이 어긋남
      const nearM = s => { let m = Infinity; for (let j = 0; j < line.length; j++) { const d = dist(s, P(line[j])); if (d < m) m = d; } return m; };
      served = served.filter(s => { if (nearM(s) > OFF_LINE_M) { offLine.push(s.seq); return false; } return true; });
    }
    const idx = detLines ? matchStops(line, served) : RT.idx;
    const cumLine = [0]; for (let i = 1; i < line.length; i++) cumLine.push(cumLine[i-1] + dist(P(line[i-1]), P(line[i])));
    const at = served.map(s => idx[s.seq]);
    const k_ = RT.straight ? P_.straightFactor : 1;   // 도로 좌표가 없으면 정류소 간 직선 × 계수
    const cumD = at.map(j => cumLine[j]*k_);
    const cumT = [0];
    for (let k = 1; k < served.length; k++) {
      const seg = cumD[k]-cumD[k-1], fast = HWY.test(served[k-1].name) || HWY.test(served[k].name);
      cumT.push(cumT[k-1] + seg/1000/(fast ? P_.hwySpeed : P_.citySpeed)*60 + P_.dwell);
    }
    const far = served.reduce((m, s, k) => Math.max(m, dist(s, P(line[at[k]]))), 0);
    return {served, offLine, line, at, cumD, cumT, far, pos: Object.fromEntries(served.map((s, k) => [s.seq, k]))};
  }

  // ---------- 탐색망 색인 (정류소 노드 · 도보 이웃 격자) ----------
  function index(net, P_){
    if (net._ix && net._ix.xfer === P_.xferWalk) return net._ix;
    const nodes = [], off = [];
    net.forEach((r, ri) => { off.push(nodes.length); r.normal.served.forEach((s, k) => nodes.push({ri, k, s})); });
    const C = 0.005, cell = (a, b) => Math.floor(a/C)+','+Math.floor(b/C), grid = new Map();
    nodes.forEach((n, i) => { const c = cell(n.s.lat, n.s.lon); if (!grid.has(c)) grid.set(c, []); grid.get(c).push(i); });
    const near = (p, R_) => {   // p 주변 R_ m 안의 노드 [i, m]
      const out = [], dl = Math.ceil(R_/550)+0, a0 = Math.floor(p.lat/C), b0 = Math.floor(p.lon/C);
      for (let a = a0-dl; a <= a0+dl; a++) for (let b = b0-dl-1; b <= b0+dl+1; b++) {
        const g = grid.get(a+','+b); if (!g) continue;
        for (const i of g) { const m = dist(p, nodes[i].s); if (m <= R_) out.push([i, m]); }
      }
      return out;
    };
    const xfer = nodes.map(n => near(n.s, P_.xferWalk));
    return net._ix = {nodes, off, near, xfer: P_.xferWalk, nb: xfer};
  }
  // 최소 힙
  function Heap(){ const a = []; return {
    push(c, v){ a.push([c, v]); let i = a.length-1; while (i > 0) { const p = (i-1)>>1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } },
    pop(){ const top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2*i+1, r = l+1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; },
    get size(){ return a.length; } }; }

  // ---------- 시간 의존 최단경로 ('길찾기 API' 역할) ----------
  // opt.evAt(route, seq, Date) → 이벤트|null : 그 시각 그 정류소가 무정차면 승·하차 불가 (null 이면 정상 운행 가정)
  function plan(net, O, D, dep, opt, P_){
    const ix = index(net, P_), N = ix.nodes.length, iO = N, iD = N+1;
    const walkMin = m => m*P_.walkFactor/P_.walkSpeed;
    const evAt = opt && opt.evAt;
    const clock = m => new Date(dep.getTime() + m*60000);
    const cost = new Float64Array(N+2).fill(Infinity), time = new Float64Array(N+2).fill(Infinity), rides = new Int32Array(N+2), prev = new Array(N+2).fill(null), done = new Uint8Array(N+2);
    const H = Heap();
    const relax = (j, c, t, nr, pv) => { if (c < cost[j] - 1e-9) { cost[j] = c; time[j] = t; rides[j] = nr; prev[j] = pv; H.push(c, j); } };
    cost[iO] = 0; time[iO] = 0;
    ix.near(O, P_.maxWalk).forEach(([j, m]) => relax(j, walkMin(m), walkMin(m), 0, {type:'walk', from:iO, m}));
    const odm = dist(O, D); relax(iD, walkMin(odm), walkMin(odm), 0, {type:'walk', from:iO, m:odm});
    const toD = new Map(ix.near(D, P_.maxWalk).map(([i, m]) => [i, m]));
    while (H.size) {
      const [c0, u] = H.pop();
      if (done[u] || c0 > cost[u] + 1e-9) continue;
      done[u] = 1;
      if (u === iD) break;
      const n = ix.nodes[u], r = net[n.ri], t0 = time[u];
      const lastWalk = prev[u] && prev[u].type === 'walk';
      if (toD.has(u)) { const m = toD.get(u); relax(iD, c0 + walkMin(m), t0 + walkMin(m), rides[u], {type:'walk', from:u, m}); }
      if (!lastWalk) ix.nb[u].forEach(([j, m]) => { if (j !== u) relax(j, c0 + walkMin(m), t0 + walkMin(m), rides[u], {type:'walk', from:u, m}); });
      const v = r.normal, w = r.wait, tb = t0 + w;
      if (opt && opt.ban && opt.ban.has(r.no)) continue;
      if (evAt && evAt(r.no, n.s.seq, clock(tb))) continue;           // 승차 불가
      const board = w + (rides[u] > 0 ? P_.xferPenalty : 0);
      for (let q = n.k+1; q < v.served.length; q++) {
        const ride = v.cumT[q]-v.cumT[n.k];
        if (evAt && evAt(r.no, v.served[q].seq, clock(tb + ride))) continue;   // 하차 불가 (버스는 지나감)
        relax(ix.off[n.ri] + q, c0 + board + ride, tb + ride, rides[u]+1, {type:'ride', from:u, ri:n.ri, k:n.k, q});
      }
    }
    if (!isFinite(cost[iD])) return null;
    const legs = []; let j = iD;
    while (j !== iO) { const p = prev[j]; legs.unshift(Object.assign({to:j}, p)); j = p.from; }
    const ptOf = i => i === iO ? Object.assign({name:'출발지'}, O, {isO:true}) : i === iD ? Object.assign({name:'도착지'}, D, {isD:true}) : ix.nodes[i].s;
    const out = legs.map(l => {
      const a = ptOf(l.from), b = ptOf(l.to);
      if (l.type === 'walk') return {type:'walk', from:a, to:b, m:l.m, min:walkMin(l.m), line:[[a.lat, a.lon], [b.lat, b.lon]]};
      const r = net[l.ri], v = r.normal;
      return {type:'ride', route:r.no, from:a, to:b, nStops:l.q-l.k, m:v.cumD[l.q]-v.cumD[l.k], min:v.cumT[l.q]-v.cumT[l.k], wait:r.wait,
              seqs: v.served.slice(l.k, l.q+1).map(s => s.seq), line: v.line.slice(v.at[l.k], v.at[l.q]+1)};
    });
    const legs2 = out.filter(l => !(l.type === 'walk' && l.m < 1 && !l.from.isO && !l.to.isD));
    return {legs: legs2, cost: cost[iD], min: time[iD], walkM: legs2.filter(l => l.type === 'walk').reduce((a, l) => a+l.m, 0),
            rides: legs2.filter(l => l.type === 'ride').length};
  }
  return {dist, bearing, P, cleanPath, matchStops, prepRoute, computeDetourLines, buildVariant, plan, index, lineKm};
})();

// ===== CITYFLOW v2 : 정류장 순차 검사 → 역할별 영향 판정 → 분기 → 가지치기 → 파레토 순위 =====
// Engine.plan(...) 은 '길찾기 API' 역할 (기본 경로 R⁰ 조회 · reroute 재호출)
const CityFlow = (() => {
  const E_ = (typeof Engine !== 'undefined') ? Engine : require('./engine.js');
  const {dist} = E_;
  const hhmm = d => String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');

  // 이벤트 색인: route:seq → [이벤트]
  function eventIndex(events){
    const m = new Map();
    events.forEach(e => { if (e.seq == null) return; const k = e.route+':'+e.seq; if (!m.has(k)) m.set(k, []); m.get(k).push(e); });
    return (route, seq, t) => { const a = m.get(route+':'+seq); if (!a) return null; for (const e of a) if (t >= e.start && t <= e.end) return e; return null; };
  }

  function run(net, events, O, D, dep, P_){
    const C = Object.assign({limit:60, maxX:5, lbKmh:80, goalR:400, adjR:300, maxReroute:2, defDelay:10, maxAlt:2}, P_.cf || {});
    const walkMin = m => m*P_.walkFactor/P_.walkSpeed;
    const clock = m => new Date(dep.getTime() + m*60000);
    const fmt = m => hhmm(clock(m));
    const byNo = new Map(net.map(r => [r.no, r])), R = no => byNo.get(no);
    const evD = eventIndex(events), evAt = (route, seq, tMin) => evD(route, seq, clock(tMin));
    const lb = pos => dist(pos, D)/1000/C.lbKmh*60;
    const stats = {generated:0, A:0, B:0, C:0, D:0, cands:0, apiCalls:0, altDirect:0};
    const tree = [];
    const ix = E_.index(net, P_);

    // ---- STEP 1 : 기본 경로 R⁰ (정상 운행 길찾기) ----
    const toPlan = res => res.legs.map(l => l.type === 'walk'
      ? {type:'walk', to: l.to.isD ? 'D' : {route: l.to.route, seq: l.to.seq}}
      : {type:'bus', route:l.route, board:l.from.seq, alight:l.to.seq});
    const summary = res => res.legs.filter(l => l.type === 'ride').map(l => l.route).join('→') || '도보';
    const base = [];
    const r0 = E_.plan(net, O, D, dep, {}, P_); stats.apiCalls++;
    if (!r0) return null;
    base.push(r0);
    const used = [...new Set(r0.legs.filter(l => l.type === 'ride').map(l => l.route))];
    used.forEach(no => {
      const alt = E_.plan(net, O, D, dep, {ban: new Set([no])}, P_); stats.apiCalls++;
      if (alt && alt.legs.some(l => l.type === 'ride') && !base.some(b => summary(b) === summary(alt) && Math.abs(b.min - alt.min) < 0.5)) base.push(alt);
    });
    const T0 = Math.min(...base.map(b => b.min));
    // G : 도착지 400m 안의 정류장
    const G = ix.near(D, C.goalR).map(([i, m]) => { const n = ix.nodes[i]; return {route: net[n.ri].no, seq: n.s.seq, name: n.s.name, m}; });

    // ---- 상태 ----
    const pq = [];
    const push = s => { stats.generated++; s.key = s.t + lb(s.pos); pq.push(s); };
    const pop = () => { let k = 0; for (let i = 1; i < pq.length; i++) if (pq[i].key < pq[k].key) k = i; return pq.splice(k, 1)[0]; };
    const clone = (s, patch) => Object.assign({}, s, {plan: s.plan.map(x => Object.assign({}, x)), hist: s.hist.slice(),
      lines: s.lines.map(x => Object.assign({}, x, x.seqs ? {seqs: x.seqs.slice()} : {}, x.skipped ? {skipped: x.skipped.slice()} : {}))}, patch);
    const kids = {};
    const nextLab = s => String.fromCharCode(97 + (kids[s.label] || 0));
    const child = (s, why) => { const lab = s.label + nextLab(s); kids[s.label] = (kids[s.label] || 0) + 1; tree.push({label:lab, parent:s.label, why, status:'생성'}); return lab; };
    const mark = (lab, status) => { const n = tree.find(x => x.label === lab); if (n && !/후보|기각|제거/.test(n.status)) n.status = status; };
    base.forEach((b, i) => {
      const lab = 'R'+(i+1)+'⁰';
      tree.push({label:lab, parent:null, why:'기본 경로 '+summary(b)+' · '+b.min.toFixed(0)+'분', status:'생성'});
      push({plan: toPlan(b), li:0, cur:null, pos:Object.assign({name:'출발지'}, O), t:0, X:0, walkM:0, hist:[], label:lab, calls:0, est:false,
            verifyNeeded:false, lastStop:null, lastStopT:null, gapFrom:null, lastAlight:null, lines:[]});
    });

    const best = {};
    const dominated = s => {
      const L = s.plan[s.li];
      const k = s.li >= s.plan.length ? 'D:'+s.lastAlight
        : s.cur != null ? 'on:'+L.route+':'+s.cur+'>'+L.alight+':'+JSON.stringify(s.plan.slice(s.li+1))
        : 'at:'+s.pos.lat.toFixed(5)+','+s.pos.lon.toFixed(5)+':'+JSON.stringify(s.plan.slice(s.li));
      const arr = best[k] = best[k] || [];
      if (arr.some(b => b.t <= s.t + 1e-9 && b.X <= s.X)) return true;
      arr.push({t:s.t, X:s.X}); return false;
    };
    const stopPt = (route, seq) => { const s = R(route).RT.bySeq[seq]; return {lat:s.lat, lon:s.lon, name:s.name, seq, route}; };
    const normalNext = (route, seq) => { const v = R(route).normal, k = v.pos[seq]; return v.served[k+1] ? v.served[k+1].seq : null; };
    const segT = (route, a, b) => { const v = R(route).normal; return v.cumT[v.pos[b]] - v.cumT[v.pos[a]]; };
    const gapDelay = (route, a, b) => {   // 우회 운행에서 a→b 소요 − 정상 소요 (우회 선이 없으면 기본값)
      const dv = R(route).detour;
      if (!dv || dv.pos[a] === undefined || dv.pos[b] === undefined) return {d:C.defDelay, src:'기본값'};
      return {d:(dv.cumT[dv.pos[b]] - dv.cumT[dv.pos[a]]) - segT(route, a, b), src:'우회 선'};
    };
    const nextTarget = s => {
      for (let j = s.li+1; j < s.plan.length; j++) if (s.plan[j].type === 'bus') return {pt: stopPt(s.plan[j].route, s.plan[j].board), xfer:true};
      return {pt: Object.assign({name:'도착지'}, D, {isD:true}), xfer:false};
    };
    const walkTo = (s, pt, note) => { const m = dist(s.pos, pt); s.t += walkMin(m); s.walkM += m; s.lines.push({type:'walk', line:[[s.pos.lat, s.pos.lon], [pt.lat, pt.lon]], m, from:s.pos.name, to:pt.name, note}); s.pos = pt; };
    const alightAt = (s, route, seq) => {
      const pt = stopPt(route, seq), ll = s.lines[s.lines.length-1];
      ll.to = pt.name; ll.toSeq = seq; if (ll.seqs) { ll.seqs = ll.seqs.slice(0, ll.seqs.indexOf(seq)+1); ll.det = (ll.skipped || []).some(q => ll.seqs.includes(q)); }
      s.pos = pt; s.cur = null; s.lastStop = null; s.gapFrom = null; s.lastAlight = route+':'+seq; s.li++;
    };
    // 탑승 중인 상태에서 '직전 실제 정차 정류장'에 내린 상태로 되돌리기
    const alightBack = s => {
      const L = s.plan[s.li], a = clone(s, {t: s.lastStopT});
      let cut = -1; a.hist.forEach((h, i) => { if (h.route === L.route && h.seq === s.lastStop) cut = i; });
      a.hist = a.hist.slice(0, cut+1).concat(a.hist.slice(cut+1).filter(h => h.role !== '경유'));
      alightAt(a, L.route, s.lastStop);
      return a;
    };
    // 남은 경로를 새 plan 으로 바꿔 끼우기
    const splice = (s, newPlan) => { s.plan = s.plan.slice(0, s.li).concat(newPlan); };

    // [같은 정류장·300m 안 다른 노선] : 현재 위치에서 곧장 G 로 가는 버스 (길찾기 호출 없음)
    const directAlt = (s, why) => {
      const cand = [];
      ix.near(s.pos, C.adjR).forEach(([i, m]) => {
        const n = ix.nodes[i], r = net[n.ri], v = r.normal;
        const curRoute = s.plan[s.li] && s.plan[s.li].type === 'bus' ? s.plan[s.li].route : null;
        if (r.no === curRoute && s.cur == null && s.plan[s.li].board === n.s.seq) return;
        const tb = s.t + walkMin(m) + r.wait;
        if (evAt(r.no, n.s.seq, tb)) return;
        let bestQ = null, bestT = Infinity;
        for (let q = n.k+1; q < v.served.length; q++) {
          const sq = v.served[q], dm = dist(sq, D); if (dm > C.goalR) continue;
          const ta = tb + v.cumT[q] - v.cumT[n.k];
          if (evAt(r.no, sq.seq, ta)) continue;
          const tt = ta + walkMin(dm); if (tt < bestT) { bestT = tt; bestQ = sq.seq; }
        }
        if (bestQ != null) cand.push({route:r.no, board:n.s.seq, alight:bestQ, t:bestT, walk:m});
      });
      const byRoute = new Map(); cand.forEach(c => { const o = byRoute.get(c.route); if (!o || c.t < o.t) byRoute.set(c.route, c); });
      [...byRoute.values()].sort((a, b) => a.t - b.t).slice(0, C.maxAlt).forEach(c => {
        const n = clone(s);
        splice(n, [{type:'walk', to:{route:c.route, seq:c.board}}, {type:'bus', route:c.route, board:c.board, alight:c.alight}, {type:'walk', to:'D'}]);
        stats.altDirect++;
        n.label = child(s, why+' → '+c.route+'번 ('+R(c.route).RT.bySeq[c.board].name+' 승차'+(c.walk > 1 ? ', 도보 '+c.walk.toFixed(0)+'m' : ', 같은 정류장')+')');
        push(n);
      });
    };
    // reroute : 분기점에서 길찾기 재호출 (무정차 정류소는 피하도록 넘김) → 결과도 다시 순차 검사
    const reroute = (s, why) => {
      if (s.calls >= C.maxReroute) return;
      const n = clone(s, {calls: s.calls+1});
      const res = E_.plan(net, n.pos, D, clock(n.t), {evAt: (route, seq, t) => evD(route, seq, t)}, P_); stats.apiCalls++;
      if (!res) return;
      splice(n, toPlan(res));
      n.label = child(s, why+' → 길찾기 재호출: '+summary(res));
      push(n);
    };

    const cands = [];
    let guard = 0;
    while (pq.length && guard++ < 30000) {
      const s = pop();
      if (s.t + lb(s.pos) > T0 + C.limit) { stats.C++; mark(s.label, '조기 기각(C) · 예상 '+(s.t+lb(s.pos)).toFixed(0)+'분'); continue; }
      if (s.X - 1 > C.maxX) { stats.B++; mark(s.label, '기각(B) · 환승 '+(s.X-1)+'회'); continue; }
      if (dominated(s)) { stats.D++; mark(s.label, '우월 상태 제거(D)'); continue; }
      if (s.li >= s.plan.length) {
        if (s.t > T0 + C.limit) { stats.A++; mark(s.label, '기각(A) · +'+(s.t-T0).toFixed(0)+'분'); continue; }
        stats.cands++; cands.push(s); mark(s.label, '후보 · '+s.t.toFixed(0)+'분'); continue;
      }
      const L = s.plan[s.li];
      if (L.type === 'walk') {
        const pt = L.to === 'D' ? Object.assign({name:'도착지'}, D, {isD:true}) : stopPt(L.to.route, L.to.seq);
        const n = clone(s, {li: s.li+1}); walkTo(n, pt); push(n); continue;
      }
      const Rt = R(L.route), role0 = s.X === 0 ? '승차' : '환승(승차)';
      if (s.cur == null) {
        const bs = Rt.RT.bySeq[L.board];
        if (dist(s.pos, bs) > 1) { const w = clone(s); walkTo(w, stopPt(L.route, L.board), '환승 정류장 이동'); push(w); continue; }
        const eta = s.t + Rt.wait, ev = evAt(L.route, L.board, eta);
        if (ev) {
          s.hist.push({route:L.route, seq:L.board, name:bs.name, eta:fmt(eta), role:role0, impact:'무정차'+(ev.verified ? '' : ' (확인 필요)'), action:'경량 분기: 같은 노선 앞·뒤 정류장 / 다른 노선 / 재탐색'});
          if (!ev.verified) s.verifyNeeded = true;
          mark(s.label, '분기 · '+bs.name+' 승차 무정차');
          const v = Rt.normal, k = v.pos[L.board];
          let back = null, fwd = null;
          for (let j = k-1; j >= 0; j--) if (!evAt(L.route, v.served[j].seq, eta)) { back = v.served[j].seq; break; }
          for (let j = k+1; j < v.served.length; j++) if (!evAt(L.route, v.served[j].seq, eta)) { fwd = v.served[j].seq; break; }
          [[back, '뒤'], [fwd != null && v.pos[fwd] < v.pos[L.alight] ? fwd : null, '앞']].forEach(([q, w]) => {
            if (q == null) return;
            const m = dist(s.pos, Rt.RT.bySeq[q]); if (m > P_.maxWalk) return;
            const n = clone(s); n.plan[n.li].board = q; walkTo(n, stopPt(L.route, q), '승차 정류장 이동');
            n.label = child(s, '승차 무정차 → 같은 노선 '+w+'쪽 '+Rt.RT.bySeq[q].name+'까지 도보 '+m.toFixed(0)+'m'); push(n);
          });
          directAlt(s, '승차 무정차 · 다른 노선');
          reroute(s, '승차 무정차');
          continue;
        }
        const n = clone(s, {cur: L.board, t: eta, X: s.X+1, lastStop: L.board, lastStopT: eta});
        n.hist.push({route:L.route, seq:L.board, name:bs.name, eta:fmt(eta), role:role0, impact:'정상', action:'탑승 (대기 '+Rt.wait.toFixed(0)+'분)'});
        n.lines.push({type:'bus', route:L.route, from:bs.name, fromSeq:L.board, seqs:[L.board], to:null});
        push(n); continue;
      }
      // 탑승 중: 다음 정류장 하나 검사
      const nx = normalNext(L.route, s.cur);
      if (nx == null) { mark(s.label, '노선 끝'); continue; }
      const n = clone(s);
      n.t += segT(L.route, s.cur, nx); n.cur = nx; n.lines[n.lines.length-1].seqs.push(nx);
      const ev = evAt(L.route, nx, n.t), ns = Rt.RT.bySeq[nx];
      const isEnd = nx === L.alight || (L.alight === 9999 && !ev), tgt = nextTarget(n);
      const role = isEnd ? (tgt.xfer ? '환승(하차)' : '하차') : '경유';
      if (ev && !ev.verified) n.verifyNeeded = true;
      if (!ev) {
        if (n.gapFrom != null) {
          const g = gapDelay(L.route, n.gapFrom, nx); n.t += g.d; n.est = true;
          n.hist.push({route:L.route, seq:nx, name:ns.name, eta:fmt(n.t), role, impact:'정상 (합류 후 정차)', action:'우회 지연 '+(g.d >= 0 ? '+' : '')+g.d.toFixed(1)+'분 반영 (추정·'+g.src+')'});
          n.gapFrom = null;
        } else n.hist.push({route:L.route, seq:nx, name:ns.name, eta:fmt(n.t), role, impact:'정상', action: isEnd ? (L.alight === 9999 ? '하차 (계속 탑승 후 첫 정차)' : '하차') : '다음 정류장'});
        n.lastStop = nx; n.lastStopT = n.t;
        if (isEnd) alightAt(n, L.route, nx);
        push(n); continue;
      }
      if (n.gapFrom == null) n.gapFrom = s.lastStop;
      if (!isEnd) {   // PASS_SKIP
        { const ll = n.lines[n.lines.length-1]; ll.det = true; ll.skipped = (ll.skipped || []).concat(nx); }
        n.hist.push({route:L.route, seq:nx, name:ns.name, eta:fmt(n.t), role, impact:'무정차 · 우회'+(ev.verified ? '' : ' (확인 필요)'), action:'분기 없음 · 계속 탑승'});
        push(n); continue;
      }
      // STOP_SKIP (하차 / 환승 하차)
      mark(s.label, '분기 · '+ns.name+' 하차 무정차');
      s.hist.push({route:L.route, seq:nx, name:ns.name, eta:fmt(n.t), role, impact:'무정차'+(ev.verified ? '' : ' (확인 필요)'),
                   action:'경량 분기 ①직전 정차 하차 ②다음 정차(합류) 하차'+(tgt.xfer ? ' · 환승 정류장 이동' : ' · 목표 재설정')+' · 다른 노선'});
      if (!ev.verified) s.verifyNeeded = true;
      const canBack = s.lastStop != null && s.lastStop !== L.board;
      if (canBack) {   // ① 직전 정차 정류장 하차 → 도보
        const a = alightBack(s);
        a.hist.push({route:L.route, seq:s.lastStop, name:Rt.RT.bySeq[s.lastStop].name, eta:fmt(a.t), role:'하차(변경)', impact:'정상', action:'직전 정차 정류장에서 하차 → 도보'});
        a.label = child(s, '하차 무정차 → 직전 정차 '+Rt.RT.bySeq[s.lastStop].name+' 하차 + 도보'); push(a);
      }
      {   // ② 계속 탑승 → 다음 정차(합류) 정류장 하차
        const b = clone(s); b.plan[b.li].alight = 9999; b.hist.pop();
        b.label = child(s, '하차 무정차 → 계속 탑승, 다음 정차(합류) 정류장 하차 + 도보'); push(b);
      }
      if (!tgt.xfer) {   // ④ 목표 재설정: 같은 노선의 다른 정상 G 정류장
        const v = Rt.normal;
        G.filter(g => g.route === L.route && v.pos[g.seq] > v.pos[nx] && !evAt(L.route, g.seq, n.t)).slice(0, 1).forEach(g => {
          const b = clone(s); b.plan[b.li].alight = g.seq; b.hist.pop();
          b.label = child(s, '도착 정류장 무정차 → 목표 재설정: G 의 '+g.name+'('+g.seq+')까지 계속 탑승'); push(b);
        });
      }
      if (canBack) {   // ⑤ 직전 정차 정류장에서 내려 다른 노선 / ③ 길찾기 재호출
        const a = alightBack(s);
        directAlt(a, '하차 무정차 · '+Rt.RT.bySeq[s.lastStop].name+'에서 다른 노선 환승');
        reroute(a, '하차 무정차 · 직전 정차 정류장 기준');
      }
    }
    return {T0, base, G, cands, stats, tree, ranked: rank(cands)};
  }
  function rank(cands){
    const uniq = [];
    cands.forEach(c => { const sig = c.lines.filter(l => !(l.type === 'walk' && l.m < 1)).map(l => l.type+':'+(l.route||'')+':'+l.from+'>'+l.to).join('|'); if (!uniq.some(u => u.sig === sig)) uniq.push({c, sig}); });
    const cs = uniq.map(u => u.c);
    const dom = (a, b) => a.t <= b.t && a.X <= b.X && a.walkM <= b.walkM && (a.t < b.t || a.X < b.X || a.walkM < b.walkM);
    const front = cs.filter(c => !cs.some(o => o !== c && dom(o, c)));
    front.sort((a, b) => a.t - b.t || a.X - b.X || a.walkM - b.walkM);
    return front.slice(0, 3);
  }
  return {run, eventIndex};
})();

// ===== 시나리오별 탐색망·이벤트 구성 =====
const NetBuild = (() => {
  const E_ = (typeof Engine !== 'undefined') ? Engine : require('./engine.js');
  // 이벤트 배열 → 객체 (시각은 KST)
  function events(DATA, key){
    const S = DATA.scen[key], T = hm => new Date(S.date+'T'+hm+':00+09:00');
    return S.events.map(e => {
      const unknownEnd = !e[8];
      return {route:e[0], dir:e[1], seq:e[2], ars:e[3], name:e[4], lat:e[5], lon:e[6], start:T(e[7]), end:T(e[8] || S.defEnd), endType:e[9],
              verified: !!e[10] && !unknownEnd, note: (e[11] || '') + (unknownEnd ? ' / 종료 시각 미정(통제해제시) → '+S.defEnd+'까지 통제로 가정' : ''), detour:e[12] || ''};
    });
  }
  // 노선 준비 (한 번): 정상 경로 · 정류소 매칭
  const prepped = new Map();
  function prep(rt){
    if (prepped.has(rt)) return prepped.get(rt);
    const RT = E_.prepRoute(JSON.parse(JSON.stringify(rt)));
    prepped.set(rt, RT); return RT;
  }
  // 행사별 우회 설정(DATA.scen[key].cfg)을 노선에 붙인 사본. 같은 노선이라도 행사마다 우회가 다름
  const boundC = new Map();
  function bound(key, base, cfg){ let m = boundC.get(key); if (!m) boundC.set(key, m = new WeakMap()); let o = m.get(base); if (!o) m.set(base, o = Object.assign({}, base, {cfg})); return o; }
  // 우회 선은 행사·노선별로 한 번만 계산
  const detCache = new Map();
  async function detLines(rt, key, onStat, scen){
    const ck = scen+'|'+rt.no; if (detCache.has(ck)) return detCache.get(ck);
    const RT = prep(rt);
    const p = E_.computeDetourLines(RT, key).then(d => { onStat && onStat(rt.no, RT, d); return d; });
    detCache.set(ck, p); return p;
  }
  // 탐색망: [{no, RT, stops, normal, detour|null, wait}]
  async function net(DATA, key, extra, evs, P_, restKey, onStat, progress){
    const S = DATA.scen[key], out = [];
    const all = Object.assign({}, DATA.routes, extra || {}), cfgs = S.cfg || {};
    const SRC = {}, RTs = {};
    for (const no of Object.keys(all)) { SRC[no] = cfgs[no] ? bound(key, all[no], cfgs[no]) : all[no]; RTs[no] = prep(SRC[no]); }
    Object.values(RTs).forEach(R => { R.borrow = RTs; });   // 우회 구간이 다른 노선의 정류소·도로 좌표를 빌려 씀
    {   // 우회 선 계산을 동시 6개씩 (노선이 많아 순서대로 하면 오래 걸림)
      const todo = Object.keys(all).filter(no => RTs[no].cfg && S.detGeom.includes(no)); let nx = 0, done = 0;
      const worker = async () => { while (nx < todo.length) { const no = todo[nx++]; try { await detLines(SRC[no], restKey, onStat, key); } catch (e) {} done++; progress && progress(done, todo.length); } };
      await Promise.all(Array.from({length: 6}, worker));
    }
    for (const no of Object.keys(all)) {
      const RT = RTs[no];
      const hw = DATA.headway[no];
      const wait = hw ? Math.min(P_.maxWait, hw/2) : P_.wait;
      let detour = null;
      if (RT.cfg && S.detGeom.includes(no)) {
        try {
          const d = await detLines(SRC[no], restKey, onStat, key);
          const skip = new Set(evs.filter(e => e.route === no && e.seq != null).map(e => e.seq));
          detour = E_.buildVariant(RT, d, skip, P_);
        } catch (err) { (S.failed || (S.failed = [])).push(no+' ('+(err && err.message || err)+')'); }
      }
      out.push({no, RT, stops: RT.stops, normal: E_.buildVariant(RT, null, new Set(), P_), detour, wait, hw: hw || null, straight: !!RT.straight});
    }
    return out;
  }
  // 노선 데이터 CSV(서울시 노선별 정류소정보 / getStaionByRoute 결과) → {노선번호: {no, stops}}
  function parseRouteCSV(rows){
    const H = rows[0].map(h => h.replace(/^﻿/, '').trim());
    const pick = names => { for (const n of names) { const i = H.findIndex(h => h.toLowerCase() === n.toLowerCase()); if (i >= 0) return i; } return -1; };
    const iNo = pick(['노선명','노선번호','busRouteNm','ROUTE_NM','route_no','노선']), iSeq = pick(['순번','seq','STTN_SEQ','정류소순번']),
          iArs = pick(['ARS-ID','ARS_ID','arsId','정류소번호','ARS번호','ars_id']), iNm = pick(['정류소명','stationNm','STTN_NM','name']),
          iX = pick(['X좌표','gpsX','x','lng','경도']), iY = pick(['Y좌표','gpsY','y','lat','위도']), iId = pick(['노선ID','busRouteId','ROUTE_ID','route_id']);
    if ([iNo, iSeq, iX, iY].some(i => i < 0)) throw new Error('필요한 열(노선명·순번·X좌표·Y좌표)을 찾지 못했습니다. 머리글: '+H.join(', '));
    const routes = {};
    rows.slice(1).forEach(r => {
      if (r.length < H.length - 1) return;
      const no = (r[iNo] || '').trim(), seq = parseInt(r[iSeq], 10), lon = parseFloat(r[iX]), lat = parseFloat(r[iY]);
      if (!no || !isFinite(seq) || !isFinite(lat) || !isFinite(lon) || lat < 33 || lat > 39) return;
      const ars = iArs >= 0 ? String(r[iArs] || '').trim() : '';
      const R_ = routes[no] = routes[no] || {no, routeId: iId >= 0 ? r[iId] : '', stops: [], _seen: new Set()};
      if (R_._seen.has(seq)) return; R_._seen.add(seq);
      R_.stops.push({seq, ars: /^\d+$/.test(ars) ? ars.padStart(5, '0') : ars, name: iNm >= 0 ? r[iNm] : '', lat, lon});
    });
    Object.values(routes).forEach(R_ => { delete R_._seen; R_.stops.sort((a, b) => a.seq - b.seq); });
    return routes;
  }
  // 이벤트와 노선 데이터 대조: 순번 + 정류소번호
  function validate(evs, all){
    let ok = 0, seqOnly = 0, miss = 0, noRoute = 0;
    evs.forEach(e => {
      const r = all[e.route]; if (!r) { noRoute++; return; }
      const s = r.stops.find(x => x.seq === e.seq);
      if (s && s.ars === e.ars) ok++; else if (s) seqOnly++; else miss++;
    });
    return {ok, seqOnly, miss, noRoute};
  }
  return {events, net, parseRouteCSV, validate, prep};
})();

const PARAMS = {walkSpeed:75, walkFactor:1.25, maxWalk:1500, xferWalk:300, wait:8, maxWait:10, xferPenalty:5, citySpeed:17, hwySpeed:60, dwell:0.4, straightFactor:1.3,
  // 지하철(1~8호선): 서울교통공사 역간 표준 운행시간 + 정차. 대기·출구 이동은 추정. 통제(무정차 공지) 대상 아님
  subwayWait:4, subwayEgress:2, subwayDwell:0.5,
  cf:{limit:60, maxX:5, lbKmh:80, goalR:400, adjR:300, maxReroute:2, defDelay:10, maxAlt:2}};

// ---- 높은 수준 API: 기존 UI는 이것만 호출하면 됨 ----
// const p = CityflowCore.createPlanner({data, scen:'nov', restKey:'카카오 REST 키', params:{...덮어쓸 값}});
// await p.prepare(progressCb)         // 우회 선 계산(카카오 길찾기 ~190회). 한 번만
// const res = p.search({lat,lon,name}, {lat,lon,name}, new Date('2026-11-01T08:30:00+09:00'))
//   res = {ranked:[후보...], base:[정상 경로...], ...} 또는 null(경로 없음)
//   후보 s: s.lines[{type:'walk'|'bus', route, from, to, seqs, det, skipped, line}], s.t(분)
//   p.net(노선별 모델), p.events(무정차 이벤트)
function createPlanner(opt){
  const params = JSON.parse(JSON.stringify(PARAMS)); Object.assign(params, opt.params || {}); if (opt.params && opt.params.cf) params.cf = Object.assign({}, PARAMS.cf, opt.params.cf);
  const scen = opt.scen || 'nov', st = {net: [], events: [], ready: false, failed: [], detStat: new Map()};
  const api = {
    params,
    get net(){ return st.net; }, get events(){ return st.events; }, get failed(){ return st.failed; }, get ready(){ return st.ready; },
    async prepare(progress){
      st.events = opt.events || NetBuild.events(opt.data, scen);
      const S = opt.data.scen[scen]; S.failed = [];
      // 지하철 노선(opt.subway = data/subway-routes.json 의 routes)은 정류소만 가진 일반 노선으로 넣고, 시간·대기만 지하철 값으로 바꿈
      const sub = opt.subway || [], extra = Object.assign({}, opt.extra || {});
      sub.forEach(r => { extra[r.no] = {no: r.no, stops: r.stops}; });
      st.net = await NetBuild.net(opt.data, scen, extra, st.events, params, opt.restKey, (no, RT, d) => st.detStat.set(no, d), progress);
      const subBy = new Map(sub.map(r => [r.no, r]));
      st.net.forEach(r => {
        const s = subBy.get(r.no); if (!s) return;
        r.subway = true; r.line = s.line; r.hw = null; r.detour = null;
        r.wait = params.subwayWait + params.subwayEgress;      // 대기 + 승강장↔지상 이동(추정)
        const v = r.normal, bySeq = new Map(s.stops.map((x, i) => [x.seq, i])), cum = [0];
        for (let k = 1; k < v.served.length; k++) {
          const a = bySeq.get(v.served[k-1].seq), b = bySeq.get(v.served[k].seq);
          let sec = 0; for (let i = a+1; i <= b; i++) sec += s.runSec[i];
          cum.push(cum[k-1] + sec/60 + params.subwayDwell);
        }
        v.cumT = cum;
      });
      st.failed = S.failed; st.ready = true; return st;
    },
    search(O, D, dep){ if (!st.ready) throw new Error('prepare()를 먼저 호출하세요'); const r = CityFlow.run(st.net, st.events, O, D, dep, params); if (r) r.dep = dep; return r; },
  };
  return api;
}

root.CityflowCore = {Engine, CityFlow, NetBuild, PARAMS, createPlanner};
})(typeof window !== 'undefined' ? window : globalThis);

// Route B 통합 서버 — 엔진 + 사용자 화면을 한 번에 띄운다 (의존성 없음, Node 18+).
//   KAKAO_REST_KEY=<카카오 REST 키> node backend/server/web.js
//   → http://localhost:8080
// server.js 는 엔진만 띄우는 원본(전달받은 그대로)이고, 이 파일은 거기에 정적 화면 서빙을 더한 것이다.
const fs = require('fs'), vm = require('vm'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '..');            // backend/
const WEB = path.join(ROOT, '..', 'frontend');      // 사용자 화면
const ctx = {console, performance, Date, JSON, Math, Object, Array, Set, Map, WeakMap, Promise,
  Float64Array, Int32Array, Uint8Array, Infinity, isFinite, parseInt, parseFloat, setTimeout,
  fetch, URL, URLSearchParams, AbortController};
if (process.env.NO_NET) ctx.fetch = () => Promise.reject(new Error('network disabled'));
ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'engine/cityflow-core.js'), 'utf8'), ctx);
const Core = ctx.CityflowCore;
const data = JSON.parse(fs.readFileSync(process.env.DATA_PATH || path.join(ROOT, 'data/cityflow-data.json'), 'utf8'));
const REST_KEY = process.env.KAKAO_REST_KEY || '';
const SUBWAY_PATH = process.env.SUBWAY_PATH || path.join(ROOT, 'data/subway-routes.json');
const SUBWAY = fs.existsSync(SUBWAY_PATH) ? JSON.parse(fs.readFileSync(SUBWAY_PATH, 'utf8')).routes : [];
const EXTRA_PATH = process.env.EXTRA_PATH || path.join(ROOT, 'data/extra-routes.json');
const EXTRA = fs.existsSync(EXTRA_PATH) ? JSON.parse(fs.readFileSync(EXTRA_PATH, 'utf8')).routes : {};
const planners = {}, status = {};
async function getPlanner(scen, subway = true) {
  if (!data.scen[scen]) throw Object.assign(new Error('unknown scen: ' + scen), {code: 400});
  const k = scen + (subway && SUBWAY.length ? '+subway' : '');
  if (!planners[k]) planners[k] = (async () => {
    const p = Core.createPlanner({data, scen, restKey: REST_KEY, subway: subway ? SUBWAY : [], extra: EXTRA});
    await p.prepare((n, m) => { status[k] = n + '/' + m; }); status[k] = 'ready'; return p;
  })();
  return planners[k];
}
const r1 = x => Math.round(x * 10) / 10;
function simplify(p, res, topN, withGeom) {
  const isSub = route => { const r = p.net.find(x => x.no === route); return !!(r && r.subway); };
  const stopOf = (route, seq) => { const r = p.net.find(x => x.no === route); const s = r && r.RT.bySeq[seq];
    return s ? {seq, name: s.name, ars: s.ars || '', lat: s.lat, lon: s.lon} : {seq}; };
  const t0 = res.dep.getTime(), fmt = m => new Date(t0 + m * 60000).toISOString();
  const leg = l => l.type === 'walk'
    ? {type: 'walk', from: l.from, to: l.to, distanceM: Math.round(l.m || 0), minutes: r1(l.min || 0), geometry: withGeom ? l.line : undefined}
    : {type: 'bus', mode: isSub(l.route) ? 'subway' : 'bus', route: l.route, from: l.from, to: l.to,
       stops: l.seqs.map(q => stopOf(l.route, q)), skippedSeqs: l.skipped || [], detour: !!l.det,
       minutes: r1(l.min || 0), geometry: withGeom ? l.line : undefined};
  return {
    departure: res.dep.toISOString(),
    normalRoute: res.base[0] && {minutes: r1(res.base[0].min), walkM: Math.round(res.base[0].walkM || 0),
      legs: res.base[0].legs.map(l => l.type === 'walk'
        ? {type: 'walk', distanceM: Math.round(l.m), geometry: withGeom ? l.line : undefined}
        : {type: 'bus', mode: isSub(l.route) ? 'subway' : 'bus', route: l.route, from: l.from.name, to: l.to.name,
           fromSeq: l.from.seq, toSeq: l.to.seq, minutes: r1(l.min), geometry: withGeom ? l.line : undefined})},
    candidates: res.ranked.slice(0, topN).map((s, i) => ({rank: i + 1, totalMinutes: r1(s.t), arrival: fmt(s.t), legs: s.lines.map(leg)})),
  };
}
const send = (res, code, obj) => { res.writeHead(code, {'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type'}); res.end(JSON.stringify(obj)); };
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8'};
function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.join(WEB, path.normalize(rel));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, {error: 'not found'});
  res.writeHead(200, {'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
  fs.createReadStream(file).pipe(res);
}
http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.url === '/health') return send(res, 200, {status, scens: Object.keys(data.scen),
    subwayRoutes: SUBWAY.length, busRoutes: Object.keys(data.routes).length + Object.keys(EXTRA).length,
    kakaoKey: REST_KEY ? 'set' : 'missing'});
  if (req.method === 'POST' && (req.url === '/route' || req.url === '/api/route')) {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const q = JSON.parse(body || '{}'), scen = q.scen || 'nov';
        const ok = pt => pt && isFinite(pt.lat) && isFinite(pt.lon);
        if (!ok(q.origin) || !ok(q.destination)) throw Object.assign(new Error('origin/destination {lat,lon} 필요'), {code: 400});
        const dep = new Date(q.departure); if (isNaN(dep)) throw Object.assign(new Error('departure(ISO8601, +09:00 포함) 필요'), {code: 400});
        const p = await getPlanner(scen, q.subway !== false);
        const r = p.search(q.origin, q.destination, dep);
        if (!r) return send(res, 200, {found: false, reason: '정상 운행 기준으로도 경로가 없음(도보 범위 안에 정류소 없음)'});
        send(res, 200, Object.assign({found: true, scen, notes: p.failed.length ? {detourFailed: p.failed} : undefined},
          simplify(p, r, q.topN || 3, q.geometry !== false)));
      } catch (e) { send(res, e.code || 500, {error: e.message}); }
    });
    return;
  }
  // 화면이 쓰는 보조 API — 장소 검색 / 도보 경로 / 실시간 도착·차량 위치.
  // 키는 서버 환경변수에만 두고 브라우저로 내려보내지 않는다.
  if (req.method === 'GET' && req.url.startsWith('/api/places')) {
    const q = (new URL(req.url, 'http://x').searchParams.get('q') || '').trim();
    if (!REST_KEY) return send(res, 503, {places: [], error: 'KAKAO_REST_KEY 가 설정되지 않았습니다.'});
    if (q.length < 2 || q.length > 80) return send(res, 200, {places: []});
    try {
      const u = new URL('https://dapi.kakao.com/v2/local/search/keyword.json');
      u.searchParams.set('query', q); u.searchParams.set('size', '5');
      const r = await fetch(u, {headers: {Authorization: 'KakaoAK ' + REST_KEY}});
      if (!r.ok) return send(res, 502, {places: [], error: '장소 검색을 사용할 수 없습니다.'});
      const d = await r.json();
      return send(res, 200, {places: (d.documents || []).map(i => ({name: i.place_name,
        address: i.road_address_name || i.address_name, latitude: Number(i.y), longitude: Number(i.x)}))});
    } catch (e) { return send(res, 502, {places: [], error: String(e.message || e)}); }
  }
  if (req.method === 'GET' && req.url.startsWith('/api/walk')) {
    const p0 = new URL(req.url, 'http://x').searchParams;
    const n = k => Number(p0.get(k));
    if (!REST_KEY) return send(res, 503, {error: 'KAKAO_REST_KEY 가 설정되지 않았습니다.'});
    if (![n('start_x'), n('end_x')].every(v => v >= 124 && v <= 132)
      || ![n('start_y'), n('end_y')].every(v => v >= 33 && v <= 39))
      return send(res, 400, {error: '좌표가 올바르지 않습니다.'});
    try {
      const u = new URL('https://dapi.kakao.com/v2/routing/walk');
      for (const k of ['start_x', 'start_y', 'end_x', 'end_y']) u.searchParams.set(k, p0.get(k));
      u.searchParams.set('route_mode', 'SHORTEST');
      const r = await fetch(u, {headers: {Authorization: 'KakaoAK ' + REST_KEY}});
      if (!r.ok) return send(res, 502, {error: '도보 경로를 조회할 수 없습니다.'});
      const d = await r.json();
      const pr = d.status === 'OK' ? (d.route || {}).properties : null;
      const dist = Number(pr && pr.totalDistance), secs = Number(pr && pr.totalTime);
      if (!(dist > 0 && secs > 0)) return send(res, 404, {error: '도보 경로가 없습니다.'});
      return send(res, 200, {meters: Math.round(dist), minutes: Math.ceil(secs / 60),
        mapUrl: typeof pr.landingUrl === 'string' && pr.landingUrl.startsWith('https://map.kakao.com/') ? pr.landingUrl : null,
        source: 'kakao_walk', eventClosuresIncluded: false});
    } catch (e) { return send(res, 502, {error: String(e.message || e)}); }
  }
  if (req.method === 'GET' && req.url.startsWith('/api/live')) {
    // 서울시 버스 도착·위치. 키가 없으면 화면이 "미제공"으로 표시하도록 빈 응답을 준다.
    const p0 = new URL(req.url, 'http://x').searchParams;
    const routeId = p0.get('routeId') || '', ars = p0.get('ars') || '', seq = Number(p0.get('seq'));
    const KEY = process.env.SEOUL_BUS_KEY || '';
    const empty = {arrival: null, positions: [], positionCount: 0,
      availability: {arrival: false, position: false}, fetchedAt: new Date().toISOString()};
    if (!KEY) return send(res, 200, Object.assign({note: 'SEOUL_BUS_KEY 가 없어 실시간 정보를 제공하지 않습니다.'}, empty));
    if (!/^\d{9}$/.test(routeId) || !/^\d{5}$/.test(ars)) return send(res, 400, {error: '노선·정류소 번호가 올바르지 않습니다.'});
    const val = (x, t) => { const m = x.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>', 'i')); return m ? m[1].trim() : ''; };
    const items = x => [...x.matchAll(/<itemList[^>]*>([\s\S]*?)<\/itemList>/gi)].map(m => {
      const o = {}; for (const f of m[1].matchAll(/<(\w+)[^>]*>([^<]*)<\/\1>/g)) o[f[1]] = f[2].trim(); return o; });
    const call = async (path, qs) => {
      const u = new URL('http://ws.bus.go.kr/api/rest/' + path);
      u.searchParams.set('serviceKey', KEY); for (const [k, v] of Object.entries(qs)) u.searchParams.set(k, v);
      const r = await fetch(u); if (!r.ok) throw new Error('upstream'); const b = await r.text();
      const c = val(b, 'headerCd'); if (c && c !== '0') throw new Error('upstream_' + c); return items(b);
    };
    const got = await Promise.allSettled([
      call('arrive/getArrInfoByRouteAll', {busRouteId: routeId}),
      call('buspos/getBusPosByRtid', {busRouteId: routeId})]);
    const arr = got[0].status === 'fulfilled' ? got[0].value : [];
    const pos = got[1].status === 'fulfilled' ? got[1].value : [];
    const at = arr.filter(i => String(i.arsId || '').padStart(5, '0') === ars);
    const first = at.find(i => Number(i.staOrd) === seq) || at[0];
    return send(res, 200, {
      arrival: first ? {stopName: first.stNm || null, stopOrder: Number(first.staOrd) || null,
        updatedAt: first.mkTm || null, detourFlag: first.deTourAt || null,
        buses: [1, 2].map(k => ({order: k, message: first['arrmsg' + k] || '', seconds: Number(first['exps' + k]) || null,
          travelMinutes: Number(first['traTime' + k]) || null, vehicleId: first['vehId' + k] || null,
          sectionOrder: Number(first['sectOrd' + k]) || null})).filter(x => x.message)} : null,
      positions: pos.map(i => ({sectionOrder: Number(i.sectOrd) || null, updatedAt: i.dataTm || null,
        latitude: Number(i.posY) || null, longitude: Number(i.posX) || null,
        stopFlag: i.stopFlag === '1', vehicleId: i.vehId || null})).filter(v => v.latitude && v.longitude),
      positionCount: pos.length,
      availability: {arrival: got[0].status === 'fulfilled', position: got[1].status === 'fulfilled'},
      fetchedAt: new Date().toISOString()});
  }
  if (req.method === 'GET') return serveStatic(req, res);
  send(res, 404, {error: 'not found'});
}).listen(process.env.PORT || 8080, () => {
  const port = process.env.PORT || 8080;
  console.log('Route B on http://localhost:' + port + '  (화면 + 엔진)');
  if (!REST_KEY) console.log('주의: KAKAO_REST_KEY 가 없어 우회 선이 직선으로 근사됩니다.');
  console.log('우회 선 계산을 시작합니다(카카오 길찾기 호출, 수 분 소요). 진행: GET /health');
  getPlanner(process.env.WARM_SCEN || 'nov').catch(e => console.error('prepare failed', e.message));
});

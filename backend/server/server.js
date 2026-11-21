// CITYFLOW 경로 엔진 서버 (의존성 없음, Node 18+).  실행: KAKAO_REST_KEY=... node server/server.js
// POST /route  {"scen":"nov","origin":{"lat":..,"lon":..,"name":".."},"destination":{...},"departure":"2026-11-01T08:30:00+09:00","topN":3}
// GET  /health
const fs = require('fs'), vm = require('vm'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '..');
const ctx = {console, performance, Date, JSON, Math, Object, Array, Set, Map, WeakMap, Promise, Float64Array, Int32Array, Uint8Array, Infinity, isFinite, parseInt, parseFloat, setTimeout, fetch, URL, URLSearchParams, AbortController};
if (process.env.NO_NET) ctx.fetch = () => Promise.reject(new Error('network disabled'));
ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'engine/cityflow-core.js'), 'utf8'), ctx);
const Core = ctx.CityflowCore;
const data = JSON.parse(fs.readFileSync(process.env.DATA_PATH || path.join(ROOT, 'data/cityflow-data.json'), 'utf8'));
const REST_KEY = process.env.KAKAO_REST_KEY || '';
// 지하철 1~8호선 (없으면 버스만). 요청의 "subway":false 로 끌 수 있음
const SUBWAY_PATH = process.env.SUBWAY_PATH || path.join(ROOT, 'data/subway-routes.json');
const SUBWAY = fs.existsSync(SUBWAY_PATH) ? JSON.parse(fs.readFileSync(SUBWAY_PATH, 'utf8')).routes : [];
// 통제 공지에 없는 버스 노선(통제 영향 없음, 실제 도로 선형 포함). 없으면 cityflow-data.json의 노선만
const EXTRA_PATH = process.env.EXTRA_PATH || path.join(ROOT, 'data/extra-routes.json');
const EXTRA = fs.existsSync(EXTRA_PATH) ? JSON.parse(fs.readFileSync(EXTRA_PATH, 'utf8')).routes : {};
const planners = {}, status = {};
async function getPlanner(scen, subway = true){
  if (!data.scen[scen]) throw Object.assign(new Error('unknown scen: '+scen), {code: 400});
  const k = scen + (subway && SUBWAY.length ? '+subway' : '');
  if (!planners[k]) planners[k] = (async () => { const p = Core.createPlanner({data, scen, restKey: REST_KEY, subway: subway ? SUBWAY : [], extra: EXTRA}); await p.prepare((n, m) => { status[k] = n+'/'+m; }); status[k] = 'ready'; return p; })();
  return planners[k];
}
const r1 = x => Math.round(x*10)/10;
// 엔진 결과 → UI용 JSON (좌표는 geometry에 분리)
function simplify(p, res, topN, withGeom){
  const isSub = route => { const r = p.net.find(x => x.no === route); return !!(r && r.subway); };
  const stopOf = (route, seq) => { const r = p.net.find(x => x.no === route); const s = r && r.RT.bySeq[seq]; return s ? {seq, name: s.name, ars: s.ars || '', lat: s.lat, lon: s.lon} : {seq}; };
  const t0 = res.dep.getTime(), fmt = m => new Date(t0 + m*60000).toISOString();
  const leg = l => l.type === 'walk'
    ? {type: 'walk', from: l.from, to: l.to, distanceM: Math.round(l.m || 0), minutes: r1(l.min || 0), geometry: withGeom ? l.line : undefined}
    : {type: 'bus', mode: isSub(l.route) ? 'subway' : 'bus', route: l.route, from: l.from, to: l.to, stops: l.seqs.map(q => stopOf(l.route, q)), skippedSeqs: l.skipped || [], detour: !!l.det, minutes: r1(l.min || 0), geometry: withGeom ? l.line : undefined};
  return {
    departure: res.dep.toISOString(),
    normalRoute: res.base[0] && {minutes: r1(res.base[0].min), walkM: Math.round(res.base[0].walkM || 0), legs: res.base[0].legs.map(l => l.type === 'walk'
      ? {type: 'walk', distanceM: Math.round(l.m), geometry: withGeom ? l.line : undefined}
      : {type: 'bus', mode: isSub(l.route) ? 'subway' : 'bus', route: l.route, from: l.from.name, to: l.to.name, fromSeq: l.from.seq, toSeq: l.to.seq, minutes: r1(l.min), geometry: withGeom ? l.line : undefined})},
    candidates: res.ranked.slice(0, topN).map((s, i) => ({rank: i+1, totalMinutes: r1(s.t), arrival: fmt(s.t), legs: s.lines.map(leg), raw: undefined})),
  };
}
const send = (res, code, obj) => { res.writeHead(code, {'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type'}); res.end(JSON.stringify(obj)); };
http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.url === '/health') return send(res, 200, {status, scens: Object.keys(data.scen), subwayRoutes: SUBWAY.length, busRoutes: Object.keys(data.routes).length + Object.keys(EXTRA).length});
  if (req.method === 'POST' && req.url === '/route') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const q = JSON.parse(body || '{}'), scen = q.scen || 'nov';
        const ok = p => p && isFinite(p.lat) && isFinite(p.lon);
        if (!ok(q.origin) || !ok(q.destination)) throw Object.assign(new Error('origin/destination {lat,lon} 필요'), {code: 400});
        const dep = new Date(q.departure); if (isNaN(dep)) throw Object.assign(new Error('departure(ISO8601, +09:00 포함) 필요'), {code: 400});
        const p = await getPlanner(scen, q.subway !== false);
        const r = p.search(q.origin, q.destination, dep);
        if (!r) return send(res, 200, {found: false, reason: '정상 운행 기준으로도 경로가 없음(도보 범위 안에 정류소 없음)'});
        send(res, 200, Object.assign({found: true, scen, notes: p.failed.length ? {detourFailed: p.failed} : undefined}, simplify(p, r, q.topN || 3, q.geometry !== false)));
      } catch (e) { send(res, e.code || 500, {error: e.message}); }
    });
    return;
  }
  send(res, 404, {error: 'not found'});
}).listen(process.env.PORT || 8080, () => { console.log('CITYFLOW engine on :' + (process.env.PORT || 8080)); getPlanner(process.env.WARM_SCEN || 'nov').catch(e => console.error('prepare failed', e.message)); });

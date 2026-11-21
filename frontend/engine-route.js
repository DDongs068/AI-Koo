/* 엔진 연결 — CITYFLOW 경로 엔진(POST /route)을 부르고 결과를 화면에 그린다.
   엔진 응답을 그대로 쓰지 않고 화면이 쓰는 모양으로 한 번 정규화한다(normalize).
   그래야 지도(map.js)와 목록이 같은 구조를 보고, 엔진 API 가 바뀌어도 이 파일만 고치면 된다.
   엔진 API 명세: backend/docs/API.md */
(() => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => new Intl.NumberFormat('ko-KR').format(v);
  const hhmm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  // 엔진이 가진 행사(시나리오). 데이터가 11/1·3/15 기준이므로 날짜로 고른다.
  const SCEN = { '2026-11-01': 'nov', '2026-03-15': 'mar' };
  const scenOf = v => SCEN[String(v).slice(0, 10)] || null;

  async function fetchPlan(origin, dest, depart, subway) {
    const scen = scenOf(depart);
    if (!scen) {
      const e = new Error('엔진 데이터는 2026-11-01(JTBC 서울마라톤)과 2026-03-15(서울마라톤) 기준입니다. 그 날짜로 조회해 주세요.');
      e.known = true; throw e;
    }
    const res = await fetch('/route', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scen,
        origin: { lat: origin.lat, lon: origin.lng, name: origin.name || '출발지' },
        destination: { lat: dest.lat, lon: dest.lng, name: dest.name || '도착지' },
        departure: String(depart).length === 16 ? `${depart}:00+09:00` : depart,
        topN: 3, geometry: true, subway: Boolean(subway),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '경로를 계산할 수 없습니다.');
    return data;
  }

  // ---------- 엔진 응답 → 화면이 쓰는 모양 ----------
  function normalize(plan, depISO, kind) {
    let t = new Date(depISO).getTime();
    const legs = (plan.legs || []).map(l => {
      const start = new Date(t);
      t += (l.minutes || 0) * 60000;
      const end = new Date(t);
      const common = { depart: hhmm(start), arrive: hhmm(end), minutes: l.minutes || 0,
        path: (l.geometry || []).map(p => [p[0], p[1]]) };
      if (l.type === 'walk') {
        return Object.assign(common, { mode: 'walk', from_name: l.from || '', to_name: l.to || '',
          distance_m: l.distanceM || 0, path_src: '' });
      }
      const skipped = (l.stops || []).filter(s => (l.skippedSeqs || []).includes(s.seq));
      return Object.assign(common, {
        mode: 'bus', kind: l.mode === 'subway' ? 'subway' : 'bus', route: l.route,
        from_name: l.from || '', to_name: l.to || '',
        stop_count: Math.max(0, (l.stops || []).length - 1),
        passed_blocks: skipped.map(s => ({ stop_name: s.name, ars: s.ars, seq: s.seq })),
        path_src: l.detour ? '우회 좌표(엔진 계산)'
          : l.mode === 'subway' ? '역 사이 직선' : '노선 공식 형상',
      });
    });
    const total = legs.reduce((s, l) => s + l.minutes, 0);
    const buses = legs.filter(l => l.mode === 'bus').map(l => l.route);
    return { kind, summary: buses.join(' → ') || '도보',
      minutes: plan.totalMinutes || plan.minutes || total,
      transfers: Math.max(0, buses.length - 1),
      walk_m: legs.filter(l => l.mode === 'walk').reduce((s, l) => s + (l.distance_m || 0), 0),
      depart: legs[0]?.depart || hhmm(new Date(depISO)),
      arrive: legs[legs.length - 1]?.arrive || '',
      legs, rank: plan.rank };
  }

  const isDetour = leg => String(leg.path_src || '').startsWith('우회 좌표');

  function legRow(leg) {
    if (leg.mode === 'walk') {
      return `<li class="timeline-walk"><span class="timeline-icon" aria-hidden="true">⇢</span><div>`
        + `<strong>도보 ${num(Math.round(leg.distance_m))}m</strong>`
        + `<small>${esc(leg.from_name)} → ${esc(leg.to_name)} · ${esc(leg.depart)}–${esc(leg.arrive)}</small></div></li>`;
    }
    const detour = isDetour(leg);
    const blocks = leg.passed_blocks || [];
    const warn = blocks.length
      ? `<p class="engine-blocks">이 구간에서 서지 않고 지나치는 정류소 ${blocks.length}곳 · `
        + blocks.slice(0, 4).map(b => esc(b.stop_name || '이름 미확인')).join(', ')
        + (blocks.length > 4 ? ` 외 ${blocks.length - 4}곳` : '') + '</p>'
      : '';
    return `<li class="timeline-ride${detour ? ' timeline-detour' : ''}">`
      + `<span class="timeline-icon" aria-hidden="true">${leg.kind === 'subway' ? '◎' : '▣'}</span><div>`
      + `<strong><b class="route-pill">${esc(leg.route)}</b> ${esc(leg.from_name)} → ${esc(leg.to_name)}</strong>`
      + `<small>${esc(leg.depart)}–${esc(leg.arrive)} · ${num(leg.stop_count)}개 ${leg.kind === 'subway' ? '역' : '정류장'} · ${esc(leg.path_src)}</small>`
      + warn + `</div></li>`;
  }

  function planCard(p, idx) {
    const chip = p.kind === 'normal' ? '통제가 없을 때의 최적 경로' : `통제 반영 경로 ${p.rank ? '· ' + p.rank + '순위' : ''}`;
    const detourLegs = p.legs.filter(isDetour).length;
    const skipped = p.legs.reduce((s, l) => s + (l.passed_blocks || []).length, 0);
    return `<div class="journey-option engine-plan${idx === 0 ? ' is-selected' : ''}" data-engine-plan="${idx}" tabindex="0" role="button" aria-pressed="${idx === 0}">`
      + `<div class="journey-option-head"><div><span>${esc(chip)}${detourLegs ? ' · 우회 운행 구간 포함' : ''}</span>`
      + `<h4>${esc(p.summary)} <small>${Math.round(p.minutes)}분 · 환승 ${p.transfers}회 · 도보 ${num(Math.round(p.walk_m))}m</small></h4></div>`
      + `<small>${esc(p.depart)} → ${esc(p.arrive)}</small></div>`
      + (skipped ? `<p class="engine-verdict">무정차 ${skipped}곳을 지나갑니다</p>` : '')
      + `<ol class="route-timeline">${p.legs.map(legRow).join('')}</ol></div>`;
  }

  function render(data, originName, destName) {
    if (!data.found) {
      return { html: `<div class="engine-result"><div class="status-block review">`
        + `<span class="status-icon" aria-hidden="true">?</span><div><span class="status-tag">경로 없음</span>`
        + `<h3>버스로 이어지는 경로를 찾지 못했어요</h3><p>${esc(data.reason || '출발지·도착지 주변에 정류소가 없습니다.')}</p>`
        + `</div></div></div>`, plans: [] };
    }
    const dep = data.departure;
    const normal = data.normalRoute ? normalize(data.normalRoute, dep, 'normal') : null;
    const cands = (data.candidates || []).map(c => normalize(c, dep, 'candidate'));
    // 통제 영향 판정: 우회 구간이나 무정차 통과가 후보에 있으면 영향 있음
    const hit = cands.some(p => p.legs.some(l => isDetour(l) || (l.passed_blocks || []).length));
    const changed = normal && cands[0] && normal.summary !== cands[0].summary;
    const affected = hit || changed;
    const shown = affected ? [...cands, ...(normal ? [normal] : [])] : [...(normal ? [normal] : []), ...cands.slice(1)];
    const kind = affected ? 'closed' : 'clear';
    const tag = affected ? '우회 반영' : '통제 영향 없음';
    const title = affected ? '통제를 반영해 경로를 다시 찾았어요' : '이 시각에는 통제 영향이 없어요';
    const copy = affected
      ? '첫 번째가 추천 경로입니다. 아래쪽 "통제가 없을 때의 최적 경로"와 비교해 보세요. 소요 시간은 추정값입니다.'
      : '입력한 날짜·시각의 무정차 공지와 대조했고, 이 경로는 통제 구간을 지나지 않습니다.';
    const detourCount = shown.reduce((s, p) => s + p.legs.filter(isDetour).length, 0);
    const failed = data.notes && data.notes.detourFailed;
    return {
      html: `<div class="engine-result">`
        + `<p class="engine-head"><span>목적지까지 가는 경로</span><small>CITYFLOW 엔진 · ${esc(data.scen === 'mar' ? '2026-03-15 서울마라톤' : '2026-11-01 JTBC 서울마라톤')}</small></p>`
        + `<div class="journey-summary"><div class="journey-path"><span>${esc(originName)}</span><i></i><span>${esc(destName)}</span></div></div>`
        + `<div class="status-block ${kind}"><span class="status-icon" aria-hidden="true">${affected ? '×' : '✓'}</span><div>`
        + `<span class="status-tag">${esc(tag)}</span><h3>${esc(title)}</h3><p>${esc(copy)}</p></div></div>`
        + shown.map((p, i) => planCard(p, i)).join('')
        + (detourCount ? `<p class="engine-legend"><span class="legend-detour"><i></i>우회 운행 구간</span>`
            + ` 빨간 점선은 통제로 길이 달라진 구간입니다(공지·노선 자료로 계산).</p>` : '')
        + (failed && failed.length ? `<p class="engine-legend">우회 선을 계산하지 못한 노선: ${esc(failed.slice(0, 3).join(', '))} — 정상 운행으로 처리했습니다.</p>` : '')
        + `<div class="notice-box">소요 시간·도착 시각과 우회 지연은 평균 속도로 계산한 <b>추정값</b>입니다. `
        + `실제 정차 여부와 당일 통제는 현장 안내로 확인해 주세요. `
        + `출처: 서울특별시 TOPIS(공공누리 제2유형 · 출처표시, 상업적 이용 금지), 서울교통공사.</div>`
        + `</div>`,
      plans: shown,
    };
  }

  function select(idx) {
    [...document.querySelectorAll('[data-engine-plan]')].forEach(el => {
      const on = Number(el.dataset.enginePlan) === idx;
      el.classList.toggle('is-selected', on);
      el.setAttribute('aria-pressed', String(on));
    });
    window.ROUTEB_ENGINE_PLAN = (window.ROUTEB_ENGINE_PLANS || [])[idx] || null;
    window.dispatchEvent(new Event('routeb:map-preview'));
  }
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-engine-plan]'); if (c) select(Number(c.dataset.enginePlan));
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const c = e.target.closest?.('[data-engine-plan]');
    if (c) { e.preventDefault(); select(Number(c.dataset.enginePlan)); }
  });

  window.RouteBEngine = {
    fetchPlan, render,
    apply(data, originName, destName) {
      const out = render(data, originName, destName);
      window.ROUTEB_ENGINE_PLANS = out.plans;
      window.ROUTEB_ENGINE_PLAN = out.plans[0] || null;
      return out.html;
    },
    clear() { window.ROUTEB_ENGINE_PLANS = []; window.ROUTEB_ENGINE_PLAN = null; },
  };
})();

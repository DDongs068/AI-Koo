const catalog = window.NOTICE_CATALOG || { date: '2026-11-01', groups: [], summary: {} };
const marchCatalog = window.MARCH_CATALOG || { groups: [] };
catalog.groups = [...catalog.groups, ...marchCatalog.groups];
const curatedRoutes = window.ROUTES || [];
const stationTab = document.getElementById('station-tab');
const journeyTab = document.getElementById('journey-tab');
const stationPanel = document.getElementById('station-panel');
const journeyPanel = document.getElementById('journey-panel');
const stationForm = document.getElementById('station-form');
const journeyForm = document.getElementById('journey-form');
const resultPanel = document.getElementById('result-panel');
const routeInput = document.getElementById('bus-number');
const stopInput = document.getElementById('stop-name');
const travelTime = document.getElementById('travel-time');
const journeyTime = document.getElementById('journey-time');
const directionOptions = document.getElementById('direction-options');
const routeNames = [...new Set(catalog.groups.map(group => group.route))].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));

travelTime.value = `${catalog.date}T08:00`;
journeyTime.value = `${catalog.date}T08:30`;   // 엔진 데이터 기준일(2026-11-01)

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const normalize = value => String(value ?? '').toLocaleLowerCase('ko').replace(/[\s·.()\-_]/g, '');
const numberFormat = value => new Intl.NumberFormat('ko-KR').format(value);
const timeLabel = value => {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  return match ? `${match[1]}년 ${Number(match[2])}월 ${Number(match[3])}일 ${match[4]}:${match[5]}` : '이용 시간 미입력';
};
const periodIsActive = (group, value) => String(value).slice(0, 10) === group.date && String(value).slice(11, 16) >= group.start && String(value).slice(11, 16) < group.end;
const groupsFor = (route, direction) => catalog.groups.filter(group => group.route === route && (!direction || group.direction === direction));

function distance(a, b) {
  if (![a?.lat, a?.lng, b?.lat, b?.lng].every(Number.isFinite)) return null;
  const x = (a.lng - b.lng) * 88800;
  const y = (a.lat - b.lat) * 111000;
  return Math.round(Math.hypot(x, y) / 10) * 10;
}

function setError(id, message = '') {
  const element = document.getElementById(id);
  element.textContent = message;
  element.hidden = !message;
}

function updateDirectionAndStops(preferred = '') {
  const groups = groupsFor(routeInput.value.trim());
  const directions = [...new Set(groups.map(group => group.direction))];
  const old = preferred || directionOptions.querySelector('input:checked')?.value || '';
  directionOptions.innerHTML = directions.length
    ? directions.map((direction, index) => `<label class="radio-card"><input type="radio" name="direction" value="${escapeHTML(direction)}" ${direction === old || (!directions.includes(old) && index === 0) ? 'checked' : ''}/><span>${escapeHTML(direction)}</span></label>`).join('')
    : '<span class="missing-direction">해당 노선의 방향 데이터가 없습니다.</span>';
  const stops = new Map();
  groups.forEach(group => group.stops.forEach(stop => {
    if (stop.ars) stops.set(stop.ars, `${stop.stop} · ${stop.ars}`);
  }));
  const curated = curatedRoutes.find(route => route.route === routeInput.value.trim());
  if (curated) curated.stops.filter(stop => !stop.virtual).forEach(stop => stops.set(stop.ars, `${stop.name} · ${stop.ars}`));
  document.getElementById('stop-suggestions').innerHTML = [...stops.values()].map(value => `<option value="${escapeHTML(value)}"></option>`).join('');
}

document.getElementById('bus-suggestions').innerHTML = routeNames.map(route => `<option value="${escapeHTML(route)}"></option>`).join('');
routeInput.addEventListener('change', () => updateDirectionAndStops());
routeInput.addEventListener('input', () => { if (routeNames.includes(routeInput.value.trim())) updateDirectionAndStops(); });

function setTab(tab) {
  const station = tab === 'station';
  stationTab.classList.toggle('active', station);
  journeyTab.classList.toggle('active', !station);
  stationTab.setAttribute('aria-selected', String(station));
  journeyTab.setAttribute('aria-selected', String(!station));
  stationPanel.hidden = !station;
  journeyPanel.hidden = station;
  if (station) renderStationResult(); else renderJourneyIntro();
}
stationTab.addEventListener('click', () => setTab('station'));
journeyTab.addEventListener('click', () => setTab('journey'));
document.querySelector('.tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const next = document.activeElement === stationTab ? journeyTab : stationTab;
  next.focus();
  setTab(next === stationTab ? 'station' : 'journey');
});

function topLine(label, time) {
  return `<div class="result-topline"><span class="result-label">${escapeHTML(label)}</span><span class="result-time">${escapeHTML(time)}</span></div>`;
}
function statusBlock(kind, tag, title, copy) {
  const icon = kind === 'closed' ? '×' : kind === 'clear' ? '✓' : '?';
  return `<div class="status-block ${kind}"><span class="status-icon" aria-hidden="true">${icon}</span><div><span class="status-tag">${escapeHTML(tag)}</span><h3>${escapeHTML(title)}</h3><p>${escapeHTML(copy)}</p></div></div>`;
}
function routeMeta(route, direction, stop, ars) {
  return `<div class="result-meta"><span class="route-pill">${escapeHTML(route)}</span><strong>${escapeHTML(stop)}</strong>${ars ? `<span class="ars-chip">ARS ${escapeHTML(ars)}</span>` : ''}<span class="meta-separator" aria-hidden="true"></span><span>${escapeHTML(direction)}</span></div>`;
}
const eventForTime = value => String(value).startsWith(marchCatalog.date) ? marchCatalog.event : String(value).startsWith(catalog.date) ? catalog.event : '해당 날짜 행사 자료 없음';
const reasonLine = group => `<p class="event-reason"><span>우회 사유</span>${escapeHTML(group?.event || catalog.event || '행사 공지')}</p>`;
function infoRow(label, value) {
  return `<div class="info-row"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`;
}
function evidence(group, stop) {
  const source = group.sourceType === 'prototype' ? group.source : stop?.page ? `원본 PDF ${stop.page}쪽` : '원문 쪽수 미확인';
  const sourceNote = group.sourceType === 'prototype' ? '제공된 3월 시험 자료에 기반한 기록입니다. 실제 행사 공지·정차 여부는 별도 확인이 필요합니다.' : '2026년 11월 1일 행사 공지 기록입니다. 실제 통제 시각과 정차 여부는 현장 안내를 확인해 주세요.';
  return `<details class="source-details"><summary>자료 근거 보기 <span>${escapeHTML(source)}</span></summary><div class="info-section">${infoRow('행사·예정 시간', `${group.date} ${group.start}–${group.end}`)}${infoRow('원본 자료', source)}${group.detour ? infoRow('자료의 우회 설명', group.detour) : ''}${infoRow('방향 근거', stop?.directionBasis || '—')}${infoRow('정류소 번호', stop?.ars ? `${stop.ars} · ${stop.idSource || '출처 미기록'}` : '번호 미확인')}${infoRow('자료 확인 상태', stop?.status || '—')}${stop?.note ? infoRow('확인 사항', stop.note) : ''}</div></details><div class="notice-box">${escapeHTML(sourceNote)} 실시간 버스 조회는 현재 운행 정보입니다.</div>`;
}

function findCandidate(routeName, direction, stop, group) {
  const route = curatedRoutes.find(item => item.route === routeName);
  const dir = route?.dirs.find(item => item.label === direction);
  const skipped = new Set(group?.skip || dir?.skip || []);
  if (!dir || !stop?.ars || !stop?.seq || !skipped.has(stop.seq)) return null;
  const from = group?.window?.[0] ?? dir.from_seq;
  const to = group?.window?.[1] ?? dir.to_seq;
  const range = route.stops.filter(item => item.seq >= from && item.seq <= to);
  const index = range.findIndex(item => item.seq === stop.seq && item.ars === stop.ars);
  if (index < 0) return null;
  const options = [];
  for (const step of [-1, 1]) {
    for (let j = index + step; j >= 0 && j < range.length; j += step) {
      const item = range[j];
      if (skipped.has(item.seq) || item.virtual) continue;
      options.push({ ...item, meters: distance(stop, item) });
      break;
    }
  }
  const near = options.filter(item => item.meters !== null && item.meters <= 1500).sort((a, b) => a.meters - b.meters)[0];
  return near || null;
}

const footsteps = `<svg viewBox="0 0 54 54" aria-hidden="true"><path d="M12 7C8 9 6 16 7 23l3 9 13-2-1-12C21 10 17 5 12 7Zm-1 29 13-2 1 7c1 5-2 9-7 10-5 1-9-3-9-8Zm29-29c5 1 8 8 8 16l-2 9-13-2 1-12c1-7 3-12 6-11Zm-7 27 13 2-1 8c0 5-4 8-9 7-5-1-7-5-6-10Z"/></svg>`;
const walkEstimate = meters => Math.max(1, Math.ceil(meters / 65));
const walkMetric = candidate => `<div class="walking-metric" data-walk-summary><span class="walking-metric-icon">${footsteps}</span><span><strong>도보 약 ${walkEstimate(candidate.meters)}분</strong><small>직선거리 ${numberFormat(candidate.meters)}m 기준 단순 추정 · 실제 경로는 더 걸릴 수 있어요</small></span></div>`;
function inlineLiveCard(route, stopName, ars, seq) {
  return `<section class="inline-live" data-live-route="${escapeHTML(route)}" data-live-name="${escapeHTML(stopName)}" data-live-ars="${escapeHTML(ars)}" data-live-seq="${escapeHTML(seq || '')}" aria-label="현재 ${escapeHTML(route)}번 버스 정보"><div class="inline-live-head"><div><span class="inline-live-dot"></span><strong>지금 ${escapeHTML(route)}번 버스</strong><small>${escapeHTML(stopName)} · ARS ${escapeHTML(ars)}</small></div><button type="button" class="inline-live-refresh" data-live-refresh aria-label="실시간 버스 정보 새로고침">새로고침</button></div><div class="inline-live-body" aria-live="polite"><p class="inline-live-loading">도착 시간과 차량 위치를 조회하는 중…</p></div><p class="inline-live-disclaimer">현재 서울시 운행 정보입니다. 위 행사 기록의 날짜·정차 여부와는 별개입니다.</p></section>`;
}
async function enhanceWalking(current, candidate) {
  const metric = resultPanel.querySelector('[data-walk-summary]');
  if (!metric || ![current?.lng, current?.lat, candidate?.lng, candidate?.lat].every(Number.isFinite)) return;
  const query = new URLSearchParams({ start_x: current.lng, start_y: current.lat, end_x: candidate.lng, end_y: candidate.lat });
  try {
    const response = await fetch(`/api/walk?${query}`);
    if (!response.ok) return;
    const walk = await response.json();
    if (!metric.isConnected || !(walk.minutes > 0 && walk.meters > 0)) return;
    metric.innerHTML = `<span class="walking-metric-icon">${footsteps}</span><span><strong>도보 약 ${numberFormat(walk.minutes)}분</strong><small>카카오 도보 경로 ${numberFormat(walk.meters)}m · 행사 통제 미반영</small></span>${walk.mapUrl ? `<a href="${escapeHTML(walk.mapUrl)}" target="_blank" rel="noopener noreferrer">경로 보기</a>` : ''}`;
  } catch { /* Keep the labelled straight-line estimate. */ }
}

function candidateCard(current, candidate, group) {
  const source = group.sourceType === 'prototype' ? '제공된 3월 시험 자료상 무정차' : '행사 공지상 무정차';
  return `<div class="route-list"><div class="route-list-head"><strong>대체 승차 위치 1곳</strong><span>행사 기록 · 검토 후보</span></div><ol class="route-timeline"><li class="timeline-closed"><span class="timeline-icon" aria-hidden="true">×</span><div><strong>${escapeHTML(current.stop)}</strong><small>현재 정류장 · ${source}</small></div></li><li class="timeline-walk"><span class="timeline-icon" aria-hidden="true">${footsteps}</span><div><strong>다음 정류장까지 도보 이동</strong>${walkMetric(candidate)}</div></li><li class="timeline-board"><span class="timeline-icon" aria-hidden="true">✓</span><div><strong>${escapeHTML(candidate.name)}</strong><small>ARS ${escapeHTML(candidate.ars)} · 기존 노선의 인접 정류장</small></div></li></ol>${inlineLiveCard(routeInput.value.trim(), candidate.name, candidate.ars, candidate.seq)}<p class="candidate-caution">행사 당일 도보 통제와 후보 정류장의 실제 정차 여부는 확인이 필요합니다.</p></div>`;
}
function noCandidateCard() {
  return `<div class="result-divider"></div><div class="plain-answer"><strong>대체 승차 위치는 아직 확인 중입니다.</strong><p>현재 자료에는 이 정류장 이후의 검증된 승차 위치나 안전한 도보 경로가 없습니다. 임의의 정류장을 추천하지 않습니다.</p></div>`;
}

function matchStops(group, query) {
  const id = query.match(/\d{5}/)?.[0];
  if (id) return group.stops.filter(stop => stop.ars === id);
  return group.stops.filter(stop => normalize(stop.stop) === normalize(query));
}
function stationChoices(stops) {
  return `<div class="station-choices"><strong>조회할 정류장을 선택해 주세요</strong><div>${stops.map(stop => `<button type="button" data-station-ars="${escapeHTML(stop.ars || '')}" ${stop.ars ? '' : 'disabled'}><span>${escapeHTML(stop.name)}</span><small>${stop.ars ? `ARS ${escapeHTML(stop.ars)}` : '정류소 번호 확인 필요'}</small></button>`).join('')}</div></div>`;
}
function stationMapData(currentArs, candidateArs = '', currentSeq = '', candidateSeq = '', noStop = false) {
  return `<span hidden data-station-map data-current-ars="${escapeHTML(currentArs || '')}" data-candidate-ars="${escapeHTML(candidateArs)}" data-current-seq="${escapeHTML(currentSeq)}" data-candidate-seq="${escapeHTML(candidateSeq)}" data-no-stop="${noStop}"></span>`;
}

function renderStationResult() {
  const route = routeInput.value.trim();
  const query = stopInput.value.trim();
  const direction = directionOptions.querySelector('input:checked')?.value || '';
  const time = travelTime.value;
  if (!route || !query) {
    setError('form-error', '버스 번호와 정류장 이름 또는 ARS 번호를 입력해 주세요.');
    return;
  }
  setError('form-error');
  const groups = groupsFor(route, direction);
  if (!groups.length) {
    resultPanel.innerHTML = topLine('조회 결과 · 확인 필요', timeLabel(time)) + statusBlock('review', '자료 없음', '이 노선·방향의 공지 자료가 없어요', '제공된 전체 CSV에 없는 조합입니다. 다른 방향을 선택하거나 공식 안내를 확인해 주세요.') + routeMeta(route, direction || '방향 미확인', query) + noCandidateCard();
    return;
  }
  const activeGroups = groups.filter(group => periodIsActive(group, time));
  if (!activeGroups.length) {
    const selectedDateGroups = groups.filter(group => group.date === time.slice(0, 10));
    const knownDate = selectedDateGroups.length > 0;
    const periods = knownDate ? selectedDateGroups : groups;
    resultPanel.innerHTML = topLine('조회 결과 · 기록 범위 밖', timeLabel(time)) + statusBlock('review', knownDate ? '예정 시간 밖' : '자료 없는 날짜', knownDate ? '선택한 시간은 이 행사의 적용 범위 밖이에요' : '선택한 날짜의 행사 자료가 없어요', '이 기록만으로 해당 시간의 정상 운행 여부를 판단할 수 없습니다.') + routeMeta(route, direction, query) + `<div class="plain-answer"><strong>${knownDate ? '선택한 날짜의 적용 예정 시간' : '제공된 행사 자료의 날짜·시간'}</strong><p>${periods.map(group => `${escapeHTML(group.date)} ${escapeHTML(group.start)}–${escapeHTML(group.end)}`).join('<br>')}</p></div>`;
    return;
  }
  const matches = activeGroups.flatMap(group => matchStops(group, query).map(stop => ({ group, stop })));
  const unique = [...new Map(matches.map(item => [`${item.stop.ars}|${item.stop.seq}`, item])).values()];
  if (unique.length > 1) {
    resultPanel.innerHTML = topLine('조회 결과 · 정류장 선택', timeLabel(time)) + statusBlock('review', '같은 이름의 정류장', '이용할 정류장을 선택해 주세요', '이름만 입력해도 검색할 수 있습니다. 같은 이름의 정류장이 여러 곳이면 아래에서 위치를 구분합니다.') + stationChoices(unique.map(item => ({ name: item.stop.stop, ars: item.stop.ars })));
    return;
  }
  if (unique.length === 1) {
    const { group, stop } = unique[0];
    const verified = stop.status === '확인' && stop.directionBasis === '원문' && stop.routeIdMatched && Boolean(stop.ars);
    const prototype = group.sourceType === 'prototype';
    const kind = verified ? 'closed' : 'review';
    const tag = verified ? '임시 무정차 · 공지 확인' : prototype ? '3월 행사 · 제공된 시험 자료' : '무정차 공지 · 추가 확인 필요';
    const title = verified ? '이 정류장은 무정차 대상으로 안내됐어요' : prototype ? '시험 자료에서 무정차로 표시된 정류장이에요' : '무정차 가능성이 있어 추가 확인이 필요해요';
    const copy = verified ? '제공된 행사 공지와 노선·정류소 자료가 이 방향의 무정차를 가리킵니다.' : prototype ? '제공된 3월 우회 시나리오에 포함됩니다. 실제 행사 공지와 정차 여부는 추가 확인이 필요합니다.' : '공지의 방향 또는 정류소 매칭에 확인 필요 표시가 있어 확정 안내로 보여주지 않습니다.';
    const candidate = (verified || (prototype && stop.status !== '확인 필요')) ? findCandidate(route, direction, stop, group) : null;
    resultPanel.innerHTML = stationMapData(stop.ars, candidate?.ars, stop.seq, candidate?.seq, true) + topLine(prototype ? '조회 결과 · 3월 시험 자료' : '조회 결과 · 11월 행사 기록', timeLabel(time)) + routeMeta(route, direction, stop.stop, stop.ars) + reasonLine(group) + statusBlock(kind, tag, title, copy) + (candidate ? candidateCard(stop, candidate, group) : noCandidateCard() + ((verified || prototype) && stop.ars ? inlineLiveCard(route, stop.stop, stop.ars, stop.seq) : '')) + evidence(group, stop);
    if (candidate) enhanceWalking(stop, candidate);
    return;
  }

  const curated = curatedRoutes.find(item => item.route === route);
  const dir = curated?.dirs.find(item => item.label === direction);
  const id = query.match(/\d{5}/)?.[0];
  const routeStops = dir ? curated.stops.filter(stop => stop.seq >= dir.from_seq && stop.seq <= dir.to_seq && !stop.virtual) : [];
  const onRoute = routeStops.filter(stop => id ? stop.ars === id : normalize(stop.name) === normalize(query));
  if (onRoute.length > 1) {
    resultPanel.innerHTML = topLine('조회 결과 · 정류장 선택', timeLabel(time)) + statusBlock('review', '같은 이름의 정류장', '이용할 정류장을 선택해 주세요', '이 노선과 방향에 같은 이름의 정류장이 여러 곳 있습니다.') + stationChoices(onRoute);
    return;
  }
  if (onRoute.length === 1) {
    const stop = onRoute[0];
    resultPanel.innerHTML = stationMapData(stop.ars, '', stop.seq) + topLine('조회 결과 · 무정차 목록 대조', timeLabel(time)) + reasonLine(activeGroups[0]) + statusBlock('clear', '해당 자료의 무정차 목록 외', '이 정류장은 무정차 목록에 없어요', '정리된 노선 자료에서 이 정류장과 방향을 찾았고, 선택한 날짜의 무정차 목록에는 포함되지 않았습니다.') + routeMeta(route, direction, stop.name, stop.ars) + `<div class="plain-answer"><strong>운행 여부는 별도 확인이 필요합니다.</strong><p>목록에 없는 것만으로 실제 정차나 버스 도착을 보증할 수 없습니다. 통제 상황과 현장 안내를 함께 확인해 주세요.</p></div>` + inlineLiveCard(route, stop.name, stop.ars, stop.seq) + evidence(activeGroups[0], { status: '무정차 목록 외', directionBasis: '정리된 노선 방향', ars: stop.ars, idSource: '노선별 정류소 정보' });
    return;
  }
  resultPanel.innerHTML = topLine('조회 결과 · 확인 필요', timeLabel(time)) + statusBlock('review', '정류소 확인 필요', '이 정류장을 안전하게 판정할 수 없어요', '무정차 CSV에서 일치하는 정류소를 찾지 못했습니다. 정류장 이름이나 번호와 방향을 다시 확인해 주세요.') + routeMeta(route, direction, query) + noCandidateCard();
}

resultPanel.addEventListener('click', event => {
  const button = event.target.closest('[data-station-ars]');
  if (!button || !button.dataset.stationArs) return;
  stopInput.value = button.dataset.stationArs;
  renderStationResult();
});

stationForm.addEventListener('submit', event => {
  event.preventDefault();
  renderStationResult();
  if (document.getElementById('form-error').hidden) revealResult();
});

function revealResult() {
  if (window.innerWidth <= 760) {
    resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const sidebar = document.querySelector('.search-panel');
  const top = resultPanel.getBoundingClientRect().top - sidebar.getBoundingClientRect().top + sidebar.scrollTop - 62;
  sidebar.scrollTo({ top, behavior: 'smooth' });
}

document.querySelectorAll('[data-sample]').forEach(button => button.addEventListener('click', () => {
  const sample = button.dataset.sample;
  routeInput.value = sample === 'unknown' ? '6001' : '6002';
  updateDirectionAndStops('공항방향');
  stopInput.value = sample === 'normal' ? '종각역.YMCA · 01683' : sample === 'unknown' ? '남대문시장 · 02605' : '광화문 · 01762';
  travelTime.value = `${catalog.date}T08:00`;
  renderStationResult();
}));

function renderJourneyIntro() {
  resultPanel.innerHTML = `<div class="journey-empty"><span class="journey-empty-icon" aria-hidden="true">⌕</span><strong>어디로 이동하시나요?</strong><p>출발지와 도착지를 입력하면 행사 무정차 기록을 확인하고, 가능한 승차 위치를 찾아드립니다.</p><small>검색 목록에서 정확한 장소나 정류장을 선택해 주세요.</small></div>`;
}

const originInput = document.getElementById('origin');
const destinationInput = document.getElementById('destination');
const placeOptions = new WeakMap();
let journeyRequest = 0;
const inputPoint = input => {
  const lat = Number(input.dataset.lat);
  const lng = Number(input.dataset.lng);
  return input.dataset.lat && input.dataset.lng && Number.isFinite(lat) && Number.isFinite(lng)
    ? { name: input.dataset.placeName || input.value, ars: input.dataset.ars || '', lat, lng } : null;
};
function showPlaceOptions(input, options) {
  const box = document.getElementById(`${input.id}-choices`);
  placeOptions.set(input, options);
  box.innerHTML = options.map((item, index) => `<button type="button" data-place-index="${index}"><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(item.detail)}</small></button>`).join('');
  box.hidden = !options.length;
}
function selectPlace(input, item) {
  input.value = item.ars ? `${item.name} · ${item.ars}` : item.name;
  input.dataset.placeName = item.name;
  input.dataset.ars = item.ars || '';
  input.dataset.lat = String(item.lat);
  input.dataset.lng = String(item.lng);
  showPlaceOptions(input, []);
  setError('journey-error');
  window.dispatchEvent(new Event('routeb:map-preview'));
}
const knownPlaceOptions = query => window.RouteBJourneyMatch.findLocations(curatedRoutes, catalog.groups, query).slice(0, 7)
  .map(stop => ({ name: stop.name, ars: stop.ars, lat: stop.lat, lng: stop.lng, detail: `버스 정류장 · ARS ${stop.ars} · 정류소 위치 자료` }));
async function kakaoPlaceOptions(query) {
  try {
    const response = await fetch(`/api/places?q=${encodeURIComponent(query)}`);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.places || []).filter(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
      .map(item => ({ name: item.name, ars: '', lat: item.latitude, lng: item.longitude, detail: item.address || '카카오 장소 검색 결과' }));
  } catch { return []; }
}
async function resolvePlaceInput(input) {
  const selected = inputPoint(input);
  if (selected) return selected;
  const query = input.value.trim();
  const known = knownPlaceOptions(query);
  if (known.length === 1) { selectPlace(input, known[0]); return inputPoint(input); }
  if (known.length > 1) { showPlaceOptions(input, known); return null; }
  const places = await kakaoPlaceOptions(query);
  if (places.length === 1) { selectPlace(input, places[0]); return inputPoint(input); }
  showPlaceOptions(input, places);
  return null;
}
for (const input of [originInput, destinationInput]) {
  let timer;
  input.addEventListener('input', () => {
    ++journeyRequest;
    delete input.dataset.lat;
    delete input.dataset.lng;
    delete input.dataset.ars;
    delete input.dataset.placeName;
    clearTimeout(timer);
    if (journeyTab.getAttribute('aria-selected') === 'true') renderJourneyIntro();
    window.dispatchEvent(new Event('routeb:map-preview'));
    const query = input.value.trim();
    if (query.length < 2) { showPlaceOptions(input, []); return; }
    timer = setTimeout(async () => {
      const known = knownPlaceOptions(query);
      const places = await kakaoPlaceOptions(query);
      if (input.value.trim() === query && !inputPoint(input)) showPlaceOptions(input, [...known, ...places].slice(0, 10));
    }, 350);
  });
  document.getElementById(`${input.id}-choices`).addEventListener('click', event => {
    const button = event.target.closest('[data-place-index]');
    if (!button) return;
    const item = placeOptions.get(input)?.[Number(button.dataset.placeIndex)];
    if (item) selectPlace(input, item);
  });
}

function journeyOptions(affected, destination, destinationPoint) {
  return affected.flatMap(({ group, stop }) => {
    const sourceUsable = group.sourceType === 'prototype' ? stop.status !== '확인 필요' : stop.status === '확인' && stop.directionBasis === '원문';
    if (!sourceUsable || !stop.routeIdMatched) return [];
    const candidate = findCandidate(group.route, group.direction, stop, group);
    if (!candidate) return [];
    const route = curatedRoutes.find(item => item.route === group.route);
    const dir = route?.dirs.find(item => item.label === group.direction);
    const eventDirection = dir ? { ...dir, skip: group.skip || dir.skip } : null;
    const destinationStops = window.RouteBJourneyMatch.findDestinations(route, eventDirection, candidate.seq, destination, destinationPoint);
    if (!destinationStops.length) return [];
    return [{ group, stop, candidate, destinationStops }];
  }).sort((a, b) => a.candidate.meters - b.candidate.meters);
}

function journeyOptionCard(option, destination) {
  const { group, stop, candidate, destinationStops } = option;
  const matched = destinationStops.length > 0;
  const destinationText = matched && destinationStops.length === 1 ? destinationStops[0].name : destination;
  const destinationNote = destinationStops.length > 1 ? `목적지와 일치하는 정류소가 ${destinationStops.length}곳입니다. ${destinationStops.slice(0, 3).map(item => escapeHTML(item.name)).join(' · ')} 중 실제 도착 지점을 확인해 주세요.` : matched ? '같은 노선의 이후 정류소 목록에서 목적지를 찾았습니다.' : '목적지까지의 연결은 확인되지 않았습니다. 승차 위치만 검토해 주세요.';
  const onward = matched ? `<li class="timeline-ride"><span class="timeline-icon" aria-hidden="true">▣</span><div><strong>${escapeHTML(group.route)}번 버스 이용 검토</strong><small>${escapeHTML(group.direction)} · 행사 당일 실제 운행 확인 필요</small></div></li><li class="timeline-destination"><span class="timeline-icon" aria-hidden="true">●</span><div><strong>${escapeHTML(destinationText)}</strong><small>같은 노선의 이후 정류소 · 도착 후보</small></div></li>` : '';
  const prototype = group.sourceType === 'prototype';
  const source = prototype ? '3월 시험 자료' : `PDF ${stop.page || '쪽수 미확인'}쪽`;
  return `<div class="journey-option" data-journey-route="${escapeHTML(group.route)}" data-journey-origin="${escapeHTML(stop.ars)}" data-journey-board="${escapeHTML(candidate.ars)}" data-journey-board-seq="${escapeHTML(candidate.seq)}" data-journey-destinations="${escapeHTML(destinationStops.map(item => item.ars).join(','))}" data-journey-destination-seq="${escapeHTML(destinationStops[0]?.seq || '')}"><div class="journey-option-head"><div><span>대체 승차 검토안 · ${prototype ? '제공된 시험 자료' : '행사 기록'}</span><h4><b class="route-pill">${escapeHTML(group.route)}</b> ${escapeHTML(group.direction)}</h4></div><small>${escapeHTML(source)}</small></div><ol class="route-timeline"><li class="timeline-closed"><span class="timeline-icon" aria-hidden="true">×</span><div><strong>${escapeHTML(stop.stop)}</strong><small>현재 출발 정류장 · ARS ${escapeHTML(stop.ars)} · 무정차 ${prototype ? '시험 자료' : '공지'}</small></div></li><li class="timeline-walk"><span class="timeline-icon" aria-hidden="true">${footsteps}</span><div><strong>다음 정류장까지 도보 이동</strong>${walkMetric(candidate)}</div></li><li class="timeline-board"><span class="timeline-icon" aria-hidden="true">✓</span><div><strong>${escapeHTML(candidate.name)}</strong><small>ARS ${escapeHTML(candidate.ars)} · 승차 검토 후보</small></div></li>${onward}</ol>${matched ? '' : `<p class="destination-unverified">${escapeHTML(destination)}까지 연결 확인 필요</p>`}${inlineLiveCard(group.route, candidate.name, candidate.ars, candidate.seq)}<p class="journey-option-note">${destinationNote} 후보 정류장의 행사 당일 실제 정차와 도보 경로의 행사 통제 반영 여부는 확인이 필요합니다.</p></div>`;
}

async function renderJourneyResult() {
  const request = ++journeyRequest;
  let origin = originInput.value.trim();
  let destination = destinationInput.value.trim();
  const time = journeyTime.value;
  if (!origin || !destination) {
    setError('journey-error', '출발지와 도착지를 모두 입력해 주세요.');
    return;
  }
  const originPoint = await resolvePlaceInput(originInput);
  if (request !== journeyRequest) return;
  if (!originPoint) {
    setError('journey-error', '출발지 검색 결과에서 정확한 위치를 선택해 주세요.');
    return;
  }
  const destinationPoint = await resolvePlaceInput(destinationInput);
  if (request !== journeyRequest) return;
  if (!destinationPoint) {
    setError('journey-error', '도착지 검색 결과에서 정확한 위치를 선택해 주세요.');
    return;
  }
  origin = originInput.value.trim();
  destination = destinationInput.value.trim();
  setError('journey-error');
  const affected = window.RouteBJourneyMatch.findAffectedOrigins(catalog.groups.filter(group => periodIsActive(group, time)), origin, originPoint);
  const unique = [...new Map(affected.map(item => [`${item.group.route}|${item.group.direction}|${item.stop.ars}`, item])).values()];
  const option = journeyOptions(unique, destination, destinationPoint)[0];
  const items = unique.slice(0, 6).map(({ group, stop }) => `<li><span class="route-pill">${escapeHTML(group.route)}</span><span>${escapeHTML(group.direction)} · ${escapeHTML(stop.stop)} ${stop.ars ? `(ARS ${escapeHTML(stop.ars)})` : ''}</span><small>${group.sourceType === 'prototype' ? '3월 시험 자료' : `PDF ${escapeHTML(stop.page || '쪽수 미확인')}쪽`} · ${escapeHTML(stop.status)}</small></li>`).join('');
  const title = option ? '목적지와 이어지는 승차 후보를 찾았어요' : unique.length ? '목적지까지 이어지는 승차 후보가 없어요' : '일치하는 무정차 공지를 찾지 못했어요';
  const copy = option ? '정리된 노선 순번과 공지를 바탕으로 한 검토안입니다. 행사 당일 정차와 전체 이동 시간은 확정되지 않았습니다.' : unique.length ? '출발지의 무정차 공지는 찾았지만, 현재 정리된 노선에서는 이 목적지까지 연결되는 버스 후보를 확인하지 못했습니다.' : '공지에 없다는 이유만으로 정상 운행을 보증할 수 없습니다.';
  const summary = `<div class="journey-summary"><div class="journey-path"><span>${escapeHTML(origin)}</span><i></i><span>${escapeHTML(destination)}</span></div></div>`;
  const outcome = option
    ? `<p class="journey-result-intro"><strong>${escapeHTML(title)}</strong><span>${escapeHTML(copy)}</span></p>${journeyOptionCard(option, destination)}`
    : statusBlock('review', '연결 확인 필요', title, copy) + '<div class="plain-answer"><strong>이 목적지의 대체 승차 위치는 아직 확인되지 않았습니다.</strong><p>출발지·도착지 이름을 더 구체적으로 입력하거나 공식 길찾기를 확인해 주세요. 목적지와 이어지지 않는 노선은 추천하지 않습니다.</p></div>';
  // 1) 엔진으로 목적지까지 가는 경로를 계산한다(통제 반영). 실패하면 아래 기록 대조만 보여 준다.
  let engineHTML = '<div class="engine-result engine-loading"><span class="live-spinner"></span><strong>통제를 반영한 경로를 계산하는 중</strong></div>';
  window.RouteBEngine?.clear();
  resultPanel.innerHTML = topLine('출발지·도착지 조회 · 통제 반영 경로', timeLabel(time)) + summary + engineHTML;
  try {
    const plan = await window.RouteBEngine.fetchPlan(originPoint, destinationPoint, time, false);
    if (request !== journeyRequest) return;
    engineHTML = window.RouteBEngine.apply(plan, origin, destination);
  } catch (error) {
    if (request !== journeyRequest) return;
    engineHTML = `<div class="engine-result"><div class="status-block review"><span class="status-icon" aria-hidden="true">?</span><div><span class="status-tag">경로 계산 실패</span><h3>지금은 경로를 계산할 수 없어요</h3><p>${escapeHTML(error.message || '잠시 후 다시 시도해 주세요.')}</p></div></div></div>`;
  }
  // 2) 기존 화면의 '무정차 기록 대조'는 접어서 아래에 함께 둔다(근거 확인용).
  const recordBlock = `<details class="affected-list engine-record"><summary>이 출발지의 무정차 공지 대조 ${numberFormat(unique.length)}건 보기</summary>${reasonLine(option?.group || { event: eventForTime(time) })}${outcome}${items ? `<ul>${items}</ul>${unique.length > 6 ? `<p>처음 6건만 표시했습니다.</p>` : ''}` : ''}</details>`;
  resultPanel.innerHTML = topLine('출발지·도착지 조회 · 통제 반영 경로', timeLabel(time)) + summary + engineHTML + recordBlock;
  if (option) enhanceWalking(option.stop, option.candidate);
  window.dispatchEvent(new Event('routeb:map-preview'));
}

journeyForm.addEventListener('submit', async event => {
  event.preventDefault();
  await renderJourneyResult();
  if (document.getElementById('journey-error').hidden) revealResult();
});

updateDirectionAndStops('공항방향');

// Current bus data is deliberately separate from the archived event notice.
function liveTarget(widget) {
  const route = widget.dataset.liveRoute || '';
  const ars = widget.dataset.liveArs || '';
  const routeId = catalog.routeIds?.[route] || curatedRoutes.find(item => item.route === route)?.route_id;
  const groupStop = groupsFor(route).flatMap(group => group.stops).find(stop => stop.ars === ars);
  const curatedStop = curatedRoutes.find(item => item.route === route)?.stops.find(stop => stop.ars === ars);
  return { route, ars, name: widget.dataset.liveName || '', routeId: String(routeId || ''), seq: Number(widget.dataset.liveSeq || groupStop?.seq || curatedStop?.seq) || 0 };
}
function arrivalLabel(bus) {
  const message = String(bus.message || '').trim();
  if (!message || /출발대기|운행종료|도착정보없음|차고지/.test(message)) return message || '예측 정보 없음';
  if (/곧|도착/.test(message) && !/분/.test(message)) return '곧 도착';
  const matched = message.match(/(\d+)분/);
  if (matched) return Number(matched[1]) <= 1 ? '곧 도착' : `${matched[1]}분 후 도착`;
  const minutes = Number(bus.seconds) > 0 ? Math.ceil(Number(bus.seconds) / 60) : Number(bus.travelMinutes);
  if (minutes > 0 && minutes <= 1) return '곧 도착';
  return minutes > 1 ? `${minutes}분 후 도착` : message;
}
function liveTime(iso) {
  if (!iso) return '제공 시각 없음';
  const compact = String(iso).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (compact) return `${Number(compact[2])}월 ${Number(compact[3])}일 ${compact[4]}:${compact[5]}:${compact[6]}`;
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? String(iso).replace(/\.0$/, '') : time.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function segmentLabel(route, order) {
  if (!order) return '위치 구간 정보 없음';
  const stop = curatedRoutes.find(item => item.route === route)?.stops.find(item => item.seq === order && !item.virtual);
  return stop ? `${stop.name} 부근 · ${order}번 구간` : `${order}번 정류장 구간`;
}
function renderLive(data, target, widget) {
  const arrivals = data.arrival?.buses || [];
  const positions = (data.positions || []).filter(bus => bus.sectionOrder);
  const etaCards = [1, 2].map(order => {
    const bus = arrivals.find(item => item.order === order) || (!arrivals.some(item => item.order) ? arrivals[order - 1] : null);
    const vehicle = positions.find(item => item.vehicleId && item.vehicleId === bus?.vehicleId);
    const section = vehicle?.sectionOrder || bus?.sectionOrder;
    return `<div class="inline-eta"><span>${order === 1 ? '첫 번째' : '두 번째'} 버스</span><strong>${bus ? escapeHTML(arrivalLabel(bus)) : '예측 없음'}</strong><small>${bus ? escapeHTML(segmentLabel(target.route, section)) : '서울시 도착정보 미제공'}</small></div>`;
  }).join('');
  const closest = positions.filter(bus => !target.seq || bus.sectionOrder <= target.seq).sort((a, b) => target.seq ? b.sectionOrder - a.sectionOrder : a.sectionOrder - b.sectionOrder).slice(0, 2);
  const location = closest.length ? closest.map(bus => `<span>${escapeHTML(segmentLabel(target.route, bus.sectionOrder))}${target.seq ? ` · 약 ${target.seq - bus.sectionOrder}개 정류장 전` : ''}</span>`).join('') : '<span>가까운 차량 위치가 제공되지 않았습니다.</span>';
  widget.querySelector('.inline-live-body').innerHTML = `<div class="inline-live-etas">${etaCards}</div><div class="inline-live-locations"><strong>운행 차량 위치 <span>${numberFormat(data.positionCount || 0)}대</span></strong>${location}</div><p class="inline-live-updated">서울시 조회 ${escapeHTML(liveTime(data.fetchedAt))}${!data.availability?.arrival || !data.availability?.position ? ' · 일부 정보 미제공' : ''}</p>`;
}
const liveRoute = document.getElementById('live-route');
const liveStop = document.getElementById('live-stop');
const liveResult = document.getElementById('live-result');
function liveStopOptions() {
  const route = liveRoute.value.trim();
  const names = new Set();
  groupsFor(route).forEach(group => group.stops.forEach(stop => {
    if (stop.ars) names.add(stop.stop);
  }));
  curatedRoutes.find(item => item.route === route)?.stops.filter(stop => !stop.virtual).forEach(stop => names.add(stop.name));
  document.getElementById('live-stop-suggestions').innerHTML = [...names].map(item => `<option value="${escapeHTML(item)}"></option>`).join('');
}
liveRoute.addEventListener('input', liveStopOptions);
liveStopOptions();
const resolveBottomStops = query => window.RouteBLiveStops.resolve(liveRoute.value, query, catalog, curatedRoutes);
function renderBottomLive(data, target) {
  const arrivals = data.arrival?.buses || [];
  const buses = [1, 2].map(order => {
    const bus = arrivals.find(item => item.order === order) || (!arrivals.some(item => item.order) ? arrivals[order - 1] : null);
    return `<div class="arrival-item"><span>${order}번째 버스</span><strong>${bus ? escapeHTML(arrivalLabel(bus)) : '예측 없음'}</strong></div>`;
  }).join('');
  const ordered = [...(data.positions || [])].filter(bus => bus.sectionOrder).sort((a, b) => target.seq ? Math.abs(target.seq - a.sectionOrder) - Math.abs(target.seq - b.sectionOrder) : a.sectionOrder - b.sectionOrder);
  const positions = ordered.slice(0, 3).map(bus => `<div class="position-item"><span class="position-dot"></span><span><strong>${escapeHTML(segmentLabel(target.route, bus.sectionOrder))}</strong><small>${target.seq && bus.sectionOrder <= target.seq ? `조회 정류장까지 약 ${target.seq - bus.sectionOrder}개 구간` : '정류장 순번 대조 필요'} · ${escapeHTML(liveTime(bus.updatedAt))}</small></span></div>`).join('');
  liveResult.innerHTML = `<div class="live-result-head"><div><span class="live-overline">CURRENT BUS STATUS</span><h3>${escapeHTML(target.route)} <small>· ${escapeHTML(target.name)} (ARS ${escapeHTML(target.ars)})</small></h3></div><span class="live-updated">조회 ${escapeHTML(liveTime(data.fetchedAt))}</span></div><div class="live-panels"><div class="live-panel"><h4>도착 예정 시간</h4>${buses}${!data.availability?.arrival ? '<p class="live-error">서울시 도착정보 응답을 받지 못했습니다.</p>' : ''}</div><div class="live-panel"><h4>버스 실시간 위치 <small>${numberFormat(data.positionCount || 0)}대</small></h4>${positions || '<p class="live-no-data">현재 위치가 제공되지 않습니다.</p>'}${!data.availability?.position ? '<p class="live-error">서울시 위치정보 응답을 받지 못했습니다.</p>' : ''}</div></div><p class="live-disclaimer">서울시 제공 시점의 예측·위치입니다. 차량의 정류장 실제 정차 여부는 현장 안내로 확인하세요. 2026년 11월 1일 행사 기록과 별개입니다.</p>`;
}
let bottomLiveRequest = 0;
async function fetchBottomLive(target) {
  const request = ++bottomLiveRequest;
  liveResult.innerHTML = '<div class="live-empty"><span class="live-spinner"></span><strong>서울시 실시간 정보를 불러오는 중</strong><p>도착 예측과 운행 차량 위치를 확인합니다.</p></div>';
  const query = new URLSearchParams({ routeId: target.routeId, ars: target.ars, seq: String(target.seq) });
  try {
    const response = await fetch(`/api/live?${query}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '실시간 정보를 불러올 수 없습니다.');
    if (request === bottomLiveRequest) renderBottomLive(data, target);
  } catch (error) {
    if (request === bottomLiveRequest) liveResult.innerHTML = `<div class="live-empty"><strong>지금은 조회할 수 없습니다</strong><p>${escapeHTML(error.message || '잠시 후 다시 시도해 주세요.')}</p></div>`;
  }
}
document.getElementById('live-form').addEventListener('submit', event => {
  event.preventDefault();
  ++bottomLiveRequest;
  const result = resolveBottomStops(liveStop.value);
  if (!/^\d{9}$/.test(result.routeId) || !result.candidates.length) {
    liveResult.innerHTML = '<div class="live-empty"><strong>정류장을 찾지 못했어요</strong><p>버스 번호와 정류장 이름을 확인해 주세요. 현재 제공된 노선 자료에 있는 정류장을 검색할 수 있습니다.</p></div>';
    return;
  }
  if (result.candidates.length > 1) {
    liveResult.innerHTML = `<div class="live-choice"><strong>어느 방향 정류장인가요?</strong><p>같은 이름의 정류장이 여러 곳입니다. 이용할 방향을 선택해 주세요.</p><div class="live-choice-list">${result.candidates.map(stop => `<button type="button" data-live-stop-ars="${escapeHTML(stop.ars)}"><span>${escapeHTML(stop.name)}</span><strong>${escapeHTML(stop.directions.join(' · ') || '방향 확인 필요')}</strong><small>ARS ${escapeHTML(stop.ars)}</small></button>`).join('')}</div></div>`;
    return;
  }
  const stop = result.candidates[0];
  fetchBottomLive({ ...stop, route: result.route, routeId: result.routeId });
});
liveResult.addEventListener('click', event => {
  const button = event.target.closest('[data-live-stop-ars]');
  if (!button) return;
  const result = resolveBottomStops(button.dataset.liveStopArs);
  const stop = result.candidates[0];
  if (stop && /^\d{9}$/.test(result.routeId)) fetchBottomLive({ ...stop, route: result.route, routeId: result.routeId });
});
let currentLiveWidget = null;
let liveAbort = null;
async function loadInlineLive(widget) {
  liveAbort?.abort();
  liveAbort = new AbortController();
  const controller = liveAbort;
  const target = liveTarget(widget);
  const body = widget.querySelector('.inline-live-body');
  if (!/^\d{9}$/.test(target.routeId) || !/^\d{5}$/.test(target.ars)) {
    body.innerHTML = '<p class="inline-live-error">현재 버스를 조회할 노선·정류소 번호를 확인할 수 없습니다.</p>';
    return;
  }
  body.innerHTML = '<p class="inline-live-loading">도착 시간과 차량 위치를 조회하는 중…</p>';
  const query = new URLSearchParams({ routeId: target.routeId, ars: target.ars, seq: String(target.seq) });
  try {
    const response = await fetch(`/api/live?${query}`, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '실시간 정보를 불러올 수 없습니다.');
    if (widget.isConnected && widget === currentLiveWidget && !controller.signal.aborted) renderLive(data, target, widget);
  } catch (error) {
    if (error.name !== 'AbortError' && widget.isConnected && widget === currentLiveWidget) body.innerHTML = `<p class="inline-live-error">${escapeHTML(error.message || '잠시 후 다시 시도해 주세요.')}</p>`;
  }
}
new MutationObserver(() => {
  const widget = resultPanel.querySelector('.inline-live');
  if (widget === currentLiveWidget) return;
  currentLiveWidget = widget;
  liveAbort?.abort();
  if (widget) loadInlineLive(widget);
}).observe(resultPanel, { childList: true, subtree: true });
resultPanel.addEventListener('click', event => {
  const button = event.target.closest('[data-live-refresh]');
  if (button) loadInlineLive(button.closest('.inline-live'));
});
renderStationResult();

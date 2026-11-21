/* The map locates known stops. It never represents a verified event-day route. */
(() => {
  const mount = document.getElementById('route-map');
  const caption = document.getElementById('map-caption');
  const panel = document.getElementById('result-panel');
  if (!mount || !caption || !panel) return;

  if (!window.L) {
    mount.innerHTML = '<div class="map-unavailable"><strong>지도를 불러오지 못했습니다</strong><span>정류소 위치는 검색 결과의 이름과 ARS 번호로 확인해 주세요.</span></div>';
    document.getElementById('map-reset')?.setAttribute('hidden', '');
    return;
  }

  const map = L.map(mount, { zoomControl: false, scrollWheelZoom: true }).setView([37.572, 126.978], 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
  }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  let visiblePoints = [];

  const allRoutes = window.ROUTES || [];
  const groups = window.NOTICE_CATALOG?.groups || [];
  const valid = stop => Number.isFinite(stop?.lat) && Number.isFinite(stop?.lng);
  const byArs = (route, ars) => {
    if (!ars) return null;
    const detailed = allRoutes.find(item => item.route === route)?.stops.find(stop => stop.ars === ars && !stop.virtual);
    if (valid(detailed)) return { ...detailed, name: detailed.name || detailed.stop };
    const notice = groups.filter(item => item.route === route).flatMap(item => item.stops).find(stop => stop.ars === ars && valid(stop));
    return notice ? { ...notice, name: notice.stop } : null;
  };
  const arsFrom = value => String(value || '').match(/\d{5}/)?.[0] || '';
  const markerLabels = { closed: '출발', current: '출발', boarding: '승차', dropoff: '하차', destination: '도착', station: '정류장', 'no-stop': '무정차', choice: '선택' };
  const markerIcon = kind => L.divIcon({ className: 'route-map-icon', html: `<span class="map-pin ${kind}"><b>${markerLabels[kind] || '위치'}</b></span>`, iconSize: [54, 56], iconAnchor: [27, 51] });
  const popup = (title, stop, note) => {
    const box = document.createElement('div');
    const heading = document.createElement('strong');
    const detail = document.createElement('span');
    heading.textContent = `${title} · ${stop.name}`;
    detail.textContent = `${stop.ars ? `ARS ${stop.ars} · ` : ''}${note}`;
    box.className = 'route-map-popup';
    box.append(heading, detail);
    return box;
  };
  const focus = () => {
    map.invalidateSize();
    if (visiblePoints.length === 1) map.setView(visiblePoints[0], 16);
    else if (visiblePoints.length > 1) {
      map.fitBounds(visiblePoints, { padding: [90, 90], maxZoom: 16 });
    }
    else map.setView([37.572, 126.978], 14);
  };
  const addStop = (title, stop, kind, note) => {
    if (!valid(stop)) return;
    const point = [stop.lat, stop.lng];
    visiblePoints.push(point);
    L.marker(point, { icon: markerIcon(kind), title: `${title}: ${stop.name}`, keyboard: true })
      .bindPopup(popup(title, stop, note)).addTo(layer);
  };

  const selectedPlace = id => {
    const input = document.getElementById(id);
    const lat = Number(input?.dataset.lat);
    const lng = Number(input?.dataset.lng);
    return input?.dataset.lat && input?.dataset.lng && Number.isFinite(lat) && Number.isFinite(lng)
      ? { name: input.dataset.placeName || input.value, ars: input.dataset.ars || '', lat, lng } : null;
  };
  const addNormalSegment = (route, fromSeq, toSeq) => {
    const geometry = window.ROUTE_GEOMETRY?.[route];
    const from = geometry?.stopIndex?.[fromSeq];
    const to = geometry?.stopIndex?.[toSeq];
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return false;
    const points = geometry.path.slice(Math.min(from, to), Math.max(from, to) + 1);
    if (points.length < 2) return false;
    L.polyline(points, { color: '#607594', weight: 5, opacity: .8 })
      .bindTooltip(`${route}번 기본 노선 경로 참고 · 제공된 2026년 3월 좌표 · 행사 우회 미반영`).addTo(layer);
    return true;
  };
  // 엔진이 계산한 경로를 그린다. 버스 구간은 노선 공식 형상,
  // 통제로 길이 달라진 구간은 검증된 우회 좌표(빨간 점선을 덧그려 구분).
  const BUS_COLORS = ['#245fe2', '#0f9d58', '#8e44ad', '#d35400', '#16a085'];
  const drawEnginePlan = plan => {
    const legs = (plan?.legs || []).filter(leg => (leg.path || []).length >= 2);
    if (!legs.length) return null;
    let busIndex = -1;
    let detourLegs = 0;
    const routes = [];
    legs.forEach(leg => {
      const points = leg.path.map(p => [p[0], p[1]]);
      points.forEach(pt => visiblePoints.push(pt));
      if (leg.mode !== 'bus') {
        L.polyline(points, { color: '#5b6577', weight: 4, dashArray: '4 7', opacity: .9 })
          .bindTooltip(`도보 ${Math.round(leg.distance_m || 0)}m · ${leg.from_name} → ${leg.to_name}`)
          .addTo(layer);
        return;
      }
      busIndex += 1;
      routes.push(leg.route);
      const color = BUS_COLORS[busIndex % BUS_COLORS.length];
      const detour = String(leg.path_src || '').startsWith('우회 좌표');
      if (detour) detourLegs += 1;
      L.polyline(points, { color: '#ffffff', weight: 9, opacity: .95 }).addTo(layer);
      L.polyline(points, { color, weight: 5, opacity: 1 })
        .bindTooltip(`${leg.route}번 · ${leg.from_name} → ${leg.to_name} · ${leg.path_src || '정류소 좌표'}`)
        .addTo(layer);
      if (detour) {
        L.polyline(points, { color: '#e0262b', weight: 3, dashArray: '8 8', opacity: 1 })
          .bindTooltip(`${leg.route}번 우회 운행 구간 · ${leg.path_src}`).addTo(layer);
      }
      const first = leg.path[0];
      const last = leg.path[leg.path.length - 1];
      addStop(`${leg.route}번 승차`, { name: leg.from_name, ars: '', lat: first[0], lng: first[1] },
        'boarding', detour ? '이 노선은 통제로 우회 운행합니다' : '엔진 추천 승차 위치');
      addStop(`${leg.route}번 하차`, { name: leg.to_name, ars: '', lat: last[0], lng: last[1] },
        'dropoff', '엔진 추천 하차 위치');
    });
    return { routes, detourLegs, minutes: Math.round(plan.minutes || 0) };
  };

  const stationMatches = (route, direction, query) => {
    const text = String(query || '').trim();
    if (!text) return [];
    const ars = arsFrom(text);
    const norm = value => String(value || '').toLocaleLowerCase('ko').replace(/[\s·.()\-_]/g, '');
    const curated = allRoutes.find(item => item.route === route);
    const dir = curated?.dirs.find(item => item.label === direction);
    const routeStops = dir ? curated.stops.filter(stop => stop.seq >= dir.from_seq && stop.seq <= dir.to_seq && !stop.virtual) : [];
    const noticeStops = groups.filter(group => group.route === route && group.direction === direction).flatMap(group => group.stops);
    const found = [...routeStops, ...noticeStops].filter(stop => {
      const name = stop.name || stop.stop;
      return ars ? stop.ars === ars : norm(name) === norm(text);
    });
    return [...new Map(found.filter(valid).map(stop => [stop.ars, { ...stop, name: stop.name || stop.stop }])).values()];
  };
  function render() {
    layer.clearLayers();
    visiblePoints = [];
    const journey = document.getElementById('journey-tab')?.getAttribute('aria-selected') === 'true';
    if (journey && window.ROUTEB_ENGINE_PLAN) {
      const origin = selectedPlace('origin');
      const destination = selectedPlace('destination');
      if (origin) addStop('출발지', origin, 'closed', '입력한 출발지 위치');
      if (destination) addStop('도착지', destination, 'destination', '입력한 도착지 위치');
      const drawn = drawEnginePlan(window.ROUTEB_ENGINE_PLAN);
      caption.textContent = drawn
        ? `${drawn.routes.join(' → ') || '버스'} · 약 ${drawn.minutes}분 · `
          + (drawn.detourLegs
            ? '빨간 점선은 통제로 길이 달라진 우회 운행 구간입니다(공지·노선 자료로 검증).'
            : '통제 구간을 지나지 않아 노선 공식 운행 경로로 표시했습니다.')
        : '경로 좌표가 없어 위치만 표시했습니다.';
      focus();
      return;
    }
    if (journey) {
      const originQuery = document.getElementById('origin')?.value.trim() || '';
      const destinationQuery = document.getElementById('destination')?.value.trim() || '';
      const option = panel.querySelector('.journey-option');
      const route = option?.dataset.journeyRoute || '';
      const origin = selectedPlace('origin') || (option ? byArs(route, option.dataset.journeyOrigin) : null);
      const boarding = option ? byArs(route, option.dataset.journeyBoard) : null;
      const dropoff = option ? byArs(route, option.dataset.journeyDestinations.split(',')[0]) : null;
      const selectedDestination = selectedPlace('destination');
      const destinations = selectedDestination ? [selectedDestination]
        : option ? option.dataset.journeyDestinations.split(',').map(ars => byArs(route, ars)).filter(Boolean) : [];
      if (origin) addStop('출발지', origin, 'closed', '입력한 출발지 위치 참고');
      if (boarding && boarding.ars !== origin?.ars) addStop('승차 검토 후보', boarding, 'boarding', '행사 당일 실제 정차 확인 필요');
      const normalShown = option ? addNormalSegment(route, Number(option.dataset.journeyBoardSeq), Number(option.dataset.journeyDestinationSeq)) : false;
      if (dropoff && selectedDestination && dropoff.ars !== selectedDestination.ars) addStop('하차 검토 후보', dropoff, 'dropoff', '선택한 도착지 주변의 같은 노선 정류장');
      destinations.slice(0, 4).forEach((stop, index) => addStop(destinations.length > 1 ? `도착지 후보 ${index + 1}` : '도착지', stop, 'destination', '입력한 도착지 위치 참고'));
      if (origin && boarding && origin.ars !== boarding.ars) {
        L.polyline([[origin.lat, origin.lng], [boarding.lat, boarding.lng]], { color: '#245fe2', weight: 4, dashArray: '7 9', opacity: .95 })
          .bindTooltip('출발 정류소와 승차 후보의 직선 위치 관계입니다. 실제 도보 경로가 아닙니다.').addTo(layer);
      }
      caption.textContent = option
        ? `출발 ${origin?.name || originQuery} → 승차 후보 ${boarding?.name || '확인 필요'} → 도착 ${destinations.length > 1 ? `${destinations.length}곳 중 선택` : destinations[0]?.name || destinationQuery} · ${normalShown ? '회색 선은 기본 노선 참고이며 행사 우회는 미반영입니다.' : '버스 우회 경로는 미검증입니다.'}`
        : `출발 ${origin?.name || originQuery || '위치 선택 전'} · 도착 ${destinations[0]?.name || destinationQuery || '위치 선택 전'}${origin && destinations.length ? ' · 연결 경로는 확인되지 않았습니다.' : ' · 검색 결과에서 위치를 선택해 주세요.'}`;
      focus();
      return;
    }
    const route = document.getElementById('bus-number')?.value.trim() || '';
    const direction = document.querySelector('#direction-options input:checked')?.value || '';
    const query = document.getElementById('stop-name')?.value || '';
    const mapData = panel.querySelector('[data-station-map]');
    const choices = [...panel.querySelectorAll('[data-station-ars]')].map(button => byArs(route, button.dataset.stationArs)).filter(Boolean);
    const currentArs = mapData?.dataset.currentArs || arsFrom(query);
    const candidateArs = mapData?.dataset.candidateArs || '';
    const matches = stationMatches(route, direction, query);
    const current = byArs(route, currentArs) || (choices.length ? null : matches.length === 1 ? matches[0] : null);
    const candidate = byArs(route, candidateArs);
    const isClosed = mapData?.dataset.noStop === 'true' || Boolean(panel.querySelector('.status-block.closed'));
    if (current) addStop('조회 정류장', current, isClosed ? 'no-stop' : 'station', isClosed ? '행사 무정차 공지' : '정류소 좌표 기준');
    if (candidate && candidate.ars !== current?.ars) addStop('승차 검토 후보', candidate, 'boarding', '행사 당일 실제 정차 확인 필요');
    const normalShown = current && candidate ? addNormalSegment(route, Number(mapData?.dataset.currentSeq), Number(mapData?.dataset.candidateSeq)) : false;
    if (!current && choices.length) choices.forEach(stop => addStop('정류장 선택 후보', stop, 'choice', '이름이 같은 정류장 · ARS 번호로 구분'));
    if (!current && !choices.length && matches.length > 1) matches.forEach(stop => addStop('정류장 선택 후보', stop, 'choice', '이름이 같은 정류장 · ARS 번호로 구분'));
    if (visiblePoints.length === 2) {
      L.polyline(visiblePoints, { color: '#245fe2', weight: 4, dashArray: '7 9', opacity: .95 })
        .bindTooltip('정류소 사이의 직선 위치 관계입니다. 실제 도보 경로가 아닙니다.')
        .addTo(layer);
      caption.textContent = `${current.name} → 승차 후보 ${candidate.name} · 점선은 직선 위치 관계${normalShown ? ', 회색 선은 기본 노선 참고(행사 우회 미반영)' : ''}입니다.`;
    } else if (current) caption.textContent = `${current.name} · ARS ${current.ars} 정류소 위치 · 지도를 확대하거나 움직여 확인할 수 있습니다.`;
    else if (visiblePoints.length) caption.textContent = '이름이 같은 정류장 위치입니다. 왼쪽 목록에서 ARS 번호를 선택해 주세요.';
    else caption.textContent = '정류장을 조회하면 실제 지도에 정류소 위치가 표시됩니다.';
    focus();
  }

  let updateTimer;
  new MutationObserver(() => {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(render, 80);
  }).observe(panel, { childList: true, subtree: true });
  window.addEventListener('routeb:map-preview', render);
  document.getElementById('map-reset')?.addEventListener('click', focus);
  window.addEventListener('resize', () => map.invalidateSize());
  render();
})();

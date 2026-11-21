(function () {
  const normalize = value => String(value ?? '').toLocaleLowerCase('ko').replace(/[\s·.()\-_]/g, '');

  function resolve(route, query, catalog, curatedRoutes) {
    const routeName = String(route ?? '').trim();
    const routeData = curatedRoutes.find(item => item.route === routeName);
    const routeId = String(catalog.routeIds?.[routeName] || routeData?.route_id || '');
    const stops = new Map();

    for (const item of routeData?.stops || []) {
      if (item.virtual || !/^\d{5}$/.test(String(item.ars || ''))) continue;
      stops.set(item.ars, { name: item.name, ars: item.ars, seq: item.seq || 0, directions: [] });
    }
    for (const group of catalog.groups || []) {
      if (group.route !== routeName) continue;
      for (const item of group.stops || []) {
        if (!/^\d{5}$/.test(String(item.ars || ''))) continue;
        const stop = stops.get(item.ars) || { name: item.stop, ars: item.ars, seq: item.seq || 0, directions: [] };
        if (group.direction && !stop.directions.includes(group.direction)) stop.directions.push(group.direction);
        stops.set(item.ars, stop);
      }
    }
    for (const stop of stops.values()) {
      for (const direction of routeData?.dirs || []) {
        if (stop.seq >= direction.from_seq && stop.seq <= direction.to_seq && !stop.directions.includes(direction.label)) {
          stop.directions.push(direction.label);
        }
      }
    }

    const text = String(query ?? '').trim();
    const ars = text.match(/\d{5}/)?.[0];
    const all = [...stops.values()];
    let candidates = ars ? all.filter(stop => stop.ars === ars) : all.filter(stop => normalize(stop.name) === normalize(text));
    if (!ars && !candidates.length && normalize(text).length >= 2) candidates = all.filter(stop => normalize(stop.name).includes(normalize(text)));
    return { route: routeName, routeId, candidates };
  }

  window.RouteBLiveStops = { resolve };
})();

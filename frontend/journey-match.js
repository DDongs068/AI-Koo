(function () {
  const normalize = value => String(value ?? '').toLocaleLowerCase('ko').replace(/[\s·.()\-_]/g, '');
  const valid = point => Number.isFinite(point?.lat) && Number.isFinite(point?.lng);
  const meters = (a, b) => Math.hypot((a.lat - b.lat) * 111000, (a.lng - b.lng) * 88800);

  function findDestinations(route, direction, boardingSeq, query, destinationPoint) {
    if (!route || !direction) return [];
    const id = String(query || '').match(/\d{5}/)?.[0];
    const name = normalize(query);
    if (!id && !name) return [];
    const skipped = new Set(direction.skip || []);
    return (route.stops || []).filter(stop => !stop.virtual && !skipped.has(stop.seq) && stop.seq > boardingSeq && stop.seq <= direction.to_seq
      && (id ? stop.ars === id : valid(destinationPoint) ? valid(stop) && meters(stop, destinationPoint) <= 400 : normalize(stop.name).includes(name)));
  }

  function findAffectedOrigins(groups, query, originPoint) {
    const id = String(query || '').match(/\d{5}/)?.[0];
    const name = normalize(query);
    return groups.flatMap(group => (group.stops || []).filter(stop => id ? stop.ars === id
      : valid(originPoint) ? valid(stop) && meters(stop, originPoint) <= 400
        : name.length >= 2 && normalize(stop.stop).includes(name)).map(stop => ({ group, stop })));
  }

  function findLocations(routes, groups, query) {
    const id = String(query || '').match(/\d{5}/)?.[0];
    const name = normalize(query);
    if (!id && name.length < 2) return [];
    const all = [
      ...routes.flatMap(route => route.stops.filter(stop => !stop.virtual).map(stop => ({ ...stop, route: route.route }))),
      ...groups.flatMap(group => group.stops.map(stop => ({ ...stop, name: stop.stop, route: group.route }))),
    ].filter(stop => /^\d{5}$/.test(String(stop.ars || '')) && Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
    const exact = all.filter(stop => id ? stop.ars === id : normalize(stop.name) === name);
    const matches = exact.length ? exact : id ? [] : all.filter(stop => normalize(stop.name).includes(name));
    return [...new Map(matches.map(stop => [stop.ars, stop])).values()];
  }

  window.RouteBJourneyMatch = { findDestinations, findAffectedOrigins, findLocations };
})();

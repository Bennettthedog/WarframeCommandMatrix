// Fog of war. vis[t]: 0 = never seen, 1 = explored (seen before), 2 = visible now.
// Rule: you can see your own level and anything lower, but not up a cliff,
// and higher ground between you and a tile blocks the view.
// Standing on a ramp you still see from the lower level, plus only the tiles touching the ramp.

// Can something standing at (ox, oz) see the point (tx, tz)? Same rules as computeVision:
// nothing higher than the viewer's level, and no higher ground in between.
export function lineOfSight(map, ox, oz, tx, tz) {
  const vt = map.tileAt(ox, oz), tt = map.tileAt(tx, tz), eye = map.level[vt];
  if (map.level[tt] > eye) return false;
  const steps = Math.ceil(Math.hypot(tx - ox, tz - oz) * 2);
  for (let s = 1; s < steps; s++) {
    const t2 = map.tileAt(ox + (tx - ox) * (s / steps), oz + (tz - oz) * (s / steps));
    if (t2 !== tt && t2 !== vt && map.level[t2] > eye) return false;
  }
  return true;
}

// clear: first turn last update's "visible now" into "explored". Pass false to add another
// source of vision (e.g. a second building) on top of the same update.
export function computeVision(map, ox, oz, radius, vis, clear = true) {
  const S = map.size;
  if (clear) for (let k = 0; k < vis.length; k++) if (vis[k] === 2) vis[k] = 1;

  const vt = map.tileAt(ox, oz);
  const vi = vt % S, vj = (vt / S) | 0;
  const eye = map.level[vt]; // on a ramp this is the lower level
  const R = Math.ceil(radius), r2 = radius * radius;

  for (let dj = -R; dj <= R; dj++) {
    for (let di = -R; di <= R; di++) {
      const d2 = di * di + dj * dj;
      if (d2 > r2) continue;
      const i = vi + di, j = vj + dj;
      if (!map.inBounds(i, j)) continue;
      const t = j * S + i;
      if (map.level[t] > eye) continue; // can't see up

      const tx = i + 0.5, tz = j + 0.5;
      const steps = Math.ceil(Math.sqrt(d2) * 2);
      let blocked = false;
      for (let s = 1; s < steps; s++) {
        const f = s / steps;
        const t2 = map.tileAt(ox + (tx - ox) * f, oz + (tz - oz) * f);
        if (t2 === t || t2 === vt) continue;
        if (map.level[t2] > eye) { blocked = true; break; }
      }
      if (!blocked) vis[t] = 2;
    }
  }
  vis[vt] = 2;

  // On a ramp: no view over the upper level, only the tiles touching the ramp
  // (including the other half of a two-wide ramp).
  if (map.ramp[vt] >= 0) {
    const rampTiles = [vt];
    for (let d = 0; d < 4; d++) {
      const nb = map.neighbor(vt, d);
      if (nb >= 0 && map.ramp[nb] === map.ramp[vt] && map.level[nb] === map.level[vt]) rampTiles.push(nb);
    }
    for (const r of rampTiles) {
      const ri = r % S, rj = (r / S) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (map.inBounds(ri + di, rj + dj)) vis[(rj + dj) * S + ri + di] = 2;
        }
      }
    }
  }
}

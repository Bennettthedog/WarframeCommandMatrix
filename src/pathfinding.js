// A* over the tile grid, respecting cliffs, ramps and occupied tiles.

class MinHeap {
  constructor() { this.items = []; this.pri = []; }
  get size() { return this.items.length; }
  push(item, p) {
    const it = this.items, pr = this.pri;
    let k = it.length;
    it.push(item); pr.push(p);
    while (k > 0) {
      const par = (k - 1) >> 1;
      if (pr[par] <= p) break;
      it[k] = it[par]; pr[k] = pr[par]; k = par;
    }
    it[k] = item; pr[k] = p;
  }
  pop() {
    const it = this.items, pr = this.pri;
    const top = it[0];
    const lastI = it.pop(), lastP = pr.pop();
    const n = it.length;
    if (n > 0) {
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= n) break;
        if (c + 1 < n && pr[c + 1] < pr[c]) c++;
        if (pr[c] >= lastP) break;
        it[k] = it[c]; pr[k] = pr[c]; k = c;
      }
      it[k] = lastI; pr[k] = lastP;
    }
    return top;
  }
}

const NEIGH = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

// occ[t] === -1 means the tile is free of buildings and decor.
export function isWalkable(map, occ, t) {
  return !map.isBlocked(t) && occ[t] === -1;
}

function nearestWalkable(map, occ, goal, maxR) {
  const S = map.size, gi = goal % S, gj = (goal / S) | 0;
  let best = -1, bestD = Infinity;
  for (let dj = -maxR; dj <= maxR; dj++) {
    for (let di = -maxR; di <= maxR; di++) {
      const i = gi + di, j = gj + dj;
      if (!map.inBounds(i, j)) continue;
      const t = j * S + i, d = di * di + dj * dj;
      if (d < bestD && isWalkable(map, occ, t)) { best = t; bestD = d; }
    }
  }
  return best;
}

// Returns the list of tiles to walk through (excluding start), or null if unreachable.
export function findPath(map, occ, start, goal) {
  const S = map.size, n = S * S;
  if (!isWalkable(map, occ, goal)) {
    goal = nearestWalkable(map, occ, goal, 4);
    if (goal < 0) return null;
  }
  if (start === goal) return [];

  const g = new Float32Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const gi = goal % S, gj = (goal / S) | 0;
  const h = (t) => {
    const dx = Math.abs(t % S - gi), dz = Math.abs(((t / S) | 0) - gj);
    return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  };
  const free = (t) => isWalkable(map, occ, t);

  const heap = new MinHeap();
  g[start] = 0;
  heap.push(start, h(start));
  while (heap.size) {
    const cur = heap.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const ci = cur % S, cj = (cur / S) | 0;
    for (const [dx, dz, cost] of NEIGH) {
      const ni = ci + dx, nj = cj + dz;
      if (!map.inBounds(ni, nj)) continue;
      const nb = nj * S + ni;
      if (closed[nb] || !free(nb)) continue;
      if (dx !== 0 && dz !== 0) {
        // Diagonal moves may not cut cliff corners or building corners.
        const a = cj * S + ni, b = nj * S + ci;
        if (!free(a) || !free(b)) continue;
        if (!map.canStep(cur, a) || !map.canStep(a, nb) || !map.canStep(cur, b) || !map.canStep(b, nb)) continue;
      } else if (!map.canStep(cur, nb)) continue;
      const ng = g[cur] + cost;
      if (ng < g[nb]) { g[nb] = ng; came[nb] = cur; heap.push(nb, ng + h(nb)); }
    }
  }
  if (came[goal] < 0) return null;
  const path = [];
  for (let t = goal; t !== start; t = came[t]) path.push(t);
  return path.reverse();
}

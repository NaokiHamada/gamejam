export const TILES = [...'mps'].flatMap(s => Array.from({length: 9}, (_, i) => `${i + 1}${s}`))
  .concat(Array.from({length: 7}, (_, i) => `${i + 1}z`));

export function winning(hand, shape = 'default', joker = 'none', melds = []) {
  if (melds.some(m => !validMeld(m.tiles))) return false;
  if (hand.length !== 14 - melds.length * 3 || hand.some(t => !TILES.includes(t))) return false;
  const counts = TILES.map(t => hand.filter(x => x === t).length);
  const jokerIndex = TILES.indexOf(joker);
  const wild = jokerIndex < 0 ? 0 : counts[jokerIndex];
  if (jokerIndex >= 0) counts[jokerIndex] = 0;
  const singles = counts.reduce((sum, n) => sum + n % 2, 0);
  if (!melds.length && shape !== 'standard' && Math.max(...counts) <= 2 && singles <= wild &&
      counts.filter(Boolean).length + Math.floor((wild - singles) / 2) === 7) return true;
  if (shape === 'seven_pairs') return false;
  const memo = new Map();
  const meldable = (c, w) => {
    const i = c.findIndex(Boolean);
    if (i < 0) return w % 3 === 0;
    const key = c.join(',') + ':' + w;
    if (memo.has(key)) return memo.get(key);
    const take = Math.min(3, c[i]);
    if (w >= 3 - take) {
      const rest = [...c]; rest[i] -= take;
      if (meldable(rest, w - (3 - take))) { memo.set(key, true); return true; }
    }
    if (i < 27) {
      const base = Math.floor(i / 9) * 9;
      for (let start = Math.max(base, i - 2); start <= Math.min(i, base + 6); start++) {
        const rest = [...c]; let missing = 0;
        for (let j = start; j < start + 3; j++) { if (rest[j]) rest[j]--; else missing++; }
        if (missing <= w && meldable(rest, w - missing)) { memo.set(key, true); return true; }
      }
    }
    memo.set(key, false); return false;
  };
  for (let i = 0; i < counts.length; i++) {
    if (!counts[i]) continue;
    const take = Math.min(2, counts[i]);
    if (wild >= 2 - take) {
      const rest = [...counts]; rest[i] -= take;
      if (meldable(rest, wild - (2 - take))) return true;
    }
  }
  return wild >= 2 && meldable(counts, wild - 2);
}

// Generated rules may remove or add exposed tiles. Only complete shapes are fixed melds.
export function validMeld(tiles) {
  if (!Array.isArray(tiles) || tiles.some(t => !TILES.includes(t))) return false;
  if ((tiles.length === 3 || tiles.length === 4) && tiles.every(t => t === tiles[0])) return true;
  if (tiles.length !== 3 || tiles[0][1] === 'z') return false;
  const sorted = [...tiles].sort();
  return sorted.every(t => t[1] === sorted[0][1]) &&
    Number(sorted[1][0]) === Number(sorted[0][0]) + 1 && Number(sorted[2][0]) === Number(sorted[0][0]) + 2;
}

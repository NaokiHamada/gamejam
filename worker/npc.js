// A bounded, local heuristic. Only this player's hand, public bonus settings and discard rules are used.
export function chooseDiscard(hand, rules, allowed = () => true) {
  const value = tiles => {
    const counts = new Map();
    for (const tile of tiles) counts.set(tile, (counts.get(tile) || 0) + 1);
    let score = 0;
    for (const [tile, count] of counts) {
      const n = Number(tile[0]), suit = tile[1];
      score += count >= 3 ? 12 : count === 2 ? 6 : 0;
      if (suit !== 'z') {
        if (n <= 7 && counts.has(`${n + 1}${suit}`) && counts.has(`${n + 2}${suit}`)) score += 8;
        for (const step of [1, 2]) if (n + step <= 9 && counts.has(`${n + step}${suit}`)) score += step === 1 ? 3 : 1;
      }
      if (suit === rules.bonus_suit) score += count * rules.bonus_points / 2000;
    }
    return score;
  };
  let best = -Infinity, discard = hand.at(-1);
  for (let i = hand.length - 1; i >= 0; i--) {
    if (!allowed(hand[i])) continue;
    const score = value(hand.filter((_, j) => i !== j));
    if (score > best) { best = score; discard = hand[i]; }
  }
  return discard;
}

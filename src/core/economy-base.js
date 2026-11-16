// Shared cost / stat formulas (kept separate to avoid circular imports). Pure.
// An item may have `late: { level, statGrowth, k }`: past that level each further level multiplies
// the stat by statGrowth, and the cost follows the stat (cost ∝ stat^k), so it stays a steady,
// affordable step. A board can re-anchor that price with `anchor` (coins per stat^k).

/** stat = base + perLevel × level (then × late.statGrowth per level past late.level). */
export function statAt(item, level) {
  const L = item.late && level > item.late.level ? item.late.level : level;
  const v = item.base + item.perLevel * L;
  return L === level ? v : v * Math.pow(item.late.statGrowth, level - L);
}

/** cost = base × growth^level; past late.level it tracks the stat instead. */
export function costAt(item, level, anchor) {
  const late = item.late;
  if (!late || level <= late.level) return Math.ceil(item.cost.base * Math.pow(item.cost.growth, level));
  if (anchor) return Math.ceil(anchor * Math.pow(statAt(item, level), late.k));
  const c = item.cost.base * Math.pow(item.cost.growth, late.level);
  return Math.ceil(c * Math.pow(statAt(item, level) / statAt(item, late.level), late.k));
}

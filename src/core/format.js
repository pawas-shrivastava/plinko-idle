// Number formatting for idle-scale values. Suffix list lives in config.format.

let SUFFIXES = ['', 'K', 'M', 'B', 'T'];
let LETTER_AFTER = true;

export function configureFormat(fmt) {
  SUFFIXES = fmt.suffixes;
  LETTER_AFTER = fmt.letterSuffixesAfter;
}

function suffixFor(tier) {
  if (tier < SUFFIXES.length) return SUFFIXES[tier];
  if (!LETTER_AFTER) return `e${tier * 3}`;
  // aa, ab, ... az, ba, ...
  const n = tier - SUFFIXES.length;
  const a = 'abcdefghijklmnopqrstuvwxyz';
  return a[Math.floor(n / 26) % 26] + a[n % 26];
}

/**
 * 0..999 as integers (or 1 decimal when `decimals` and < 100), then 1.23K, 12.3K, 123K, 1.23M...
 * @param {number} n
 * @param {{decimals?: boolean}} [opts]
 */
export function fmt(n, opts = {}) {
  if (!Number.isFinite(n)) return '∞';
  const neg = n < 0;
  n = Math.abs(n);
  let s;
  if (n < 1000) {
    const tenths = Math.floor(n * 10 + 1e-9) / 10;
    if (opts.decimals && n < 100 && tenths % 1 !== 0) s = tenths.toFixed(1);
    else s = String(Math.floor(n + 1e-9));
  } else {
    const tier = Math.floor(Math.log10(n) / 3);
    const scaled = n / Math.pow(1000, tier);
    const digits = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
    // floor (never round a balance up past what the player has)
    const f = Math.pow(10, digits);
    s = (Math.floor(scaled * f) / f).toFixed(digits) + suffixFor(tier);
  }
  return neg ? '-' + s : s;
}

/** Multiplier label: ×0.5, ×2, ×1.5, ×120, ×1.2K */
export function fmtMult(m) {
  if (m >= 1000) return '×' + fmt(m);
  if (m >= 10) return '×' + Math.round(m);
  return '×' + (Math.round(m * 10) / 10);
}

// Shared Arabic strings (popup, options, background).
export const REASONS = {
  low_rate: 'رمشك قليل',
  long_blinks: 'رمشات طويلة',
  slow_blinks: 'رمش بطيء',
  partial_blinks: 'رمش ناقص',
  heavy_lids: 'جفونك تقيلة',
  microsleep: 'غفوة قصيرة'
};

export function reasonsText(list) {
  const t = (list || []).map(r => REASONS[r]).filter(Boolean);
  return t.length ? t.join(' + ') : '';
}

export function fatigueLabel(score, thr = 45) {
  if (score >= thr) return 'عينك شكلها تعبانة، ريّحها';
  if (score >= Math.max(15, thr * 0.45)) return 'عينك بدأت تتجهد';
  return 'عينك مرتاحة';
}

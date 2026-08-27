/**
 * Brand palette — TS mirror of the 5 brand stops defined in index.css
 * (--brand-1 .. --brand-5).
 *
 * Used where consumers (third-party charting libs like ECharts/appkit
 * BarChart, Recharts) need actual hex strings — they can't resolve
 * CSS variables. Anywhere CSS works, prefer `var(--brand-N)` directly.
 *
 * Keep in sync with index.css. There is no single source of truth that
 * both sides can read; this is the seam. If you change one, change the
 * other.
 */
export const BRAND_PALETTE = [
  '#9184d9', // brand-1 — product blurple
  '#a7a1db', // brand-2 — light blurple
  '#6ea8fe', // brand-3 — steel blue
  '#ffab00', // brand-4 — markdown amber (np-long)
  '#ff6a52', // brand-5 — shortfall coral (np-short)
] as const;

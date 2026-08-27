/**
 * Quiet inline Databricks capability markers — a small product glyph + a
 * short label placed EXACTLY where a capability actually shows in the UI:
 *   - lakebase       → live store-state reads + write-back
 *   - genie          → the ranked recovery moves + the chat assistant
 *   - unity-catalog   → the AI-gateway line on the chat input
 *   - databricks     → the "governed on Databricks" sidebar footer
 *
 * Not decoration: keep them 13–22px and muted so they read as provenance,
 * not branding. Icons live in client/public/brand/db/.
 */
type Cap = 'lakebase' | 'genie' | 'unity-catalog' | 'databricks';

const SRC: Record<Cap, string> = {
  lakebase: '/brand/db/lakebase.svg',
  genie: '/brand/db/genie.svg',
  'unity-catalog': '/brand/db/unity-catalog.svg',
  databricks: '/brand/db/databricks-logo-white.svg',
};

export function CapabilityMarker({
  icon,
  label,
  size = 15,
  className = '',
}: {
  icon: Cap;
  label: React.ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground ${className}`}
    >
      <img
        src={SRC[icon]}
        alt=""
        aria-hidden
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="shrink-0 opacity-90"
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

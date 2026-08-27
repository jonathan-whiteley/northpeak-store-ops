/**
 * Four KPI tiles at the top of the Operations page:
 *   Lost-sales exposure (--np-short) · Markdown exposure (--np-long) ·
 *   Recoverable this week (accent) · Approved today (accent + Lakebase).
 * When the agent's write fires `dataMutated`, each tile is compared to its
 * previous value and only the ones that MOVED pulse a ring (usePulseOnChange).
 */
import { TrendingDown, AlertTriangle, Sparkles, CheckCircle2 } from 'lucide-react';
import { usePulseOnChange } from '@/lib/usePulseOnChange';
import { CapabilityMarker } from '@/shared/CapabilityMarker';
import type { PositionSummary } from '@/shared/types';

export function KpiCards({
  summary,
  recoverableUsd,
}: {
  summary: PositionSummary;
  recoverableUsd: number;
}) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
      <Card
        label="Lost-sales exposure"
        value={summary.lostSalesExposureUsd}
        icon={<TrendingDown className="size-4" />}
        accent="var(--np-short)"
        isCurrency
      />
      <Card
        label="Markdown exposure"
        value={summary.markdownExposureUsd}
        icon={<AlertTriangle className="size-4" />}
        accent="var(--np-long)"
        isCurrency
      />
      <Card
        label="Recoverable this week"
        value={recoverableUsd}
        icon={<Sparkles className="size-4" />}
        accent="var(--accent)"
        isCurrency
      />
      <Card
        label="Approved today"
        value={summary.recoveriesInProgress}
        icon={<CheckCircle2 className="size-4" />}
        accent="var(--accent)"
        isCurrency={false}
        marker={<CapabilityMarker icon="lakebase" label="Lakebase" />}
      />
    </div>
  );
}

function Card({
  label,
  value,
  icon,
  accent,
  isCurrency,
  marker,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  accent: string;
  isCurrency: boolean;
  marker?: React.ReactNode;
}) {
  const pulse = usePulseOnChange(value);

  const formatted = isCurrency
    ? new Intl.NumberFormat(undefined, {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(value)
    : value.toLocaleString();

  const fullFormatted = isCurrency
    ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : value.toLocaleString();

  return (
    <div
      className={`rounded-xl border border-border bg-card p-3 sm:p-5 transition-shadow flex flex-col ${
        pulse ? 'animate-pulse-ring' : ''
      }`}
    >
      <div className="flex items-center gap-1.5 sm:gap-2 text-[10px] sm:text-xs font-semibold uppercase tracking-[0.12em] sm:tracking-[0.15em] text-muted-foreground">
        <span style={{ color: accent }}>{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1.5 sm:mt-2 flex flex-col sm:flex-row sm:items-baseline gap-0 sm:gap-2">
        <div className="display text-2xl sm:text-3xl font-semibold text-foreground">
          {isCurrency ? '$' : ''}
          {formatted}
        </div>
        {isCurrency && (
          <div className="text-xs sm:text-sm text-muted-foreground">
            <span className="sm:hidden">≈ ${fullFormatted}</span>
            <span className="hidden sm:inline">· ${fullFormatted}</span>
          </div>
        )}
      </div>
      {marker && <div className="mt-auto pt-2.5">{marker}</div>}
    </div>
  );
}

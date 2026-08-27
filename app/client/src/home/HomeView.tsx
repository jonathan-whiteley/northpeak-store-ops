/**
 * Home / landing page.
 *
 * Template concern: this is where you tell the STORY of the use case.
 * The narrative pieces (hero persona, headline, situation, goal, journey
 * diagram quotes, starter prompts, featured action) are hardcoded in this
 * file as an EXAMPLE — rewrite them for your demo. Only `assistantScript`
 * and `branding` stay config-driven (script chain is reused by the chat
 * dock; branding is also read by the shell header).
 *
 * The journey diagram's 4 cards wire into the floating chat dock via
 * `dockController` (pub/sub in `chat/dockController.ts`) — clicking a card
 * either navigates somewhere, opens the dock, or opens the dock and
 * auto-sends a scripted prompt. That's the "see the demo in action" path.
 */
import { Fragment, useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Brain,
  CheckCircle2,
  CornerDownLeft,
  Eye,
  LayoutDashboard,
  MessageCircleQuestion,
  PackageOpen,
  RotateCcw,
  Sparkles,
  Wrench,
  Zap,
} from 'lucide-react';
import { useSession, type ScriptStep } from '@/lib/api';
import { fetchActivity, fetchPositions, fetchPositionSummary } from '@/lib/stores';
import type { ActivityEvent, PositionRow, PositionSummary } from '@/shared/types';
import { dataMutated } from '@/lib/events';
import { dockController } from '@/chat/dockController';
import { AgentLoopFlow } from '@/architecture/AgentLoopFlow';

/** Compact USD: $4.8M / $560k / $920. */
function formatUsdCompact(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

// ---------------------------------------------------------------------------
// Narrative — REPLACE for your demo.
// This is what the landing page shows. Hero persona, headline, situation,
// starter prompts, and the "featured action" are the story hooks that tell
// the viewer what this app does. Rewrite these to match your use case.
// ---------------------------------------------------------------------------

const HERO = {
  name: 'Dana Ruiz',
  role: 'SVP Retail Operations · NorthPeak Retail',
};

const STORY = {
  headline: 'Sold out in the North, dead stock in the South.',
  situation:
    'An early cold snap three weeks ago flipped cold-weather-apparel demand. ~30 northern stores are at zero on the same 5 SKUs while ~40 southern stores sit on surplus — ~$4.8M lost-sales exposure against a ~$5.6M markdown clock. Regional managers pinged me this morning.',
  goal: 'Find the worst shortfalls, get the recovery move, approve the transfer.',
};

const STARTER_QUESTIONS = [
  'Where are we short and where are we over-stocked?',
  'Why is Store 214 out of the Summit Down Parka?',
  "What's the best recovery move for Store 214?",
];

// The featured action's copy is inlined in the JSX below — the section is just
// HTML, edit it freely. The prompt text is the single thing the agent runs.
const FEATURED_ACTION_PROMPT =
  "Store 214 is short on the Summit Down Parka. Investigate why, rank the recovery moves with the model (transfer vs expedite vs substitute), draft the transfer request, and wait for my approval before recording it.";

export function HomeView() {
  const { config, configError, retry: retrySession } = useSession();
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [summary, setSummary] = useState<PositionSummary | null>(null);
  const [worstShortfall, setWorstShortfall] = useState<PositionRow | null>(null);

  useEffect(() => {
    // Activity feed + daily-brief signals. All non-fatal (page still renders
    // the story without them). Logged for dev debugging.
    const reload = () => {
      fetchActivity(20).then(setActivity).catch((e) => {
        console.error('[home] activity feed failed', e);
      });
      fetchPositionSummary().then(setSummary).catch((e) => {
        console.error('[home] position summary failed', e);
      });
      // Worst OPEN shortfall = top row sorted by exposure. Drives the brief's
      // "handle first" action + the "recover the worst shortfall" chip.
      fetchPositions({ statusGroup: 'open', sort: 'exposure' })
        .then((rows) => setWorstShortfall(rows[0] ?? null))
        .catch((e) => {
          console.error('[home] worst shortfall failed', e);
        });
    };
    reload();
    return dataMutated.subscribe(reload);
  }, []);

  if (configError) {
    return (
      <div className="p-12 max-w-xl text-sm">
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-destructive flex items-start gap-3">
          <AlertTriangle className="size-5 mt-0.5 shrink-0" />
          <div className="space-y-2">
            <div className="font-semibold">Couldn't load app config</div>
            <div className="text-destructive/80">{configError}</div>
            <button
              type="button"
              onClick={retrySession}
              className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1 text-xs hover:bg-destructive/15 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!config) {
    return <div className="p-12 text-muted-foreground">Loading…</div>;
  }

  const heroFirstName = HERO.name.split(/\s+/)[0];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-14 space-y-5 sm:space-y-7">
        {/* Daily brief — the new "Today" landing hero, wired to real data. */}
        <DailyBrief
          summary={summary}
          worstShortfall={worstShortfall}
          starters={STARTER_QUESTIONS}
        />

        {/* Jump into a module — real modules with live signals. */}
        <ModuleRow summary={summary} />

        {/* Hero */}
        <section className="space-y-5">
          <div className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            <span className="inline-block h-px w-8 bg-foreground/40" />
            {HERO.name} · {HERO.role}
          </div>
          <h1 className="display text-3xl sm:text-5xl lg:text-6xl font-semibold leading-[1.05] tracking-tight text-foreground">
            {STORY.headline}
          </h1>
          <p className="hidden sm:block text-lg text-muted-foreground leading-relaxed max-w-3xl">
            {STORY.situation}
          </p>
          <p
            className="inline-block text-sm text-foreground italic border-l-2 pl-3 py-0.5 max-w-3xl"
            style={{ borderColor: 'var(--accent)' }}
          >
            <span className="font-semibold not-italic uppercase tracking-[0.15em] text-xs text-muted-foreground mr-2">
              Goal
            </span>
            {STORY.goal}
          </p>
        </section>

        {/* Persona journey diagram */}
        <section className="space-y-5">
          <div className="hidden sm:block text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            A week of work · before noon
          </div>
          <JourneyDiagram heroName={heroFirstName} script={config.assistantScript} />

          <AgentLoopFlow />
        </section>

        {/* Starter prompts — each opens the floating assistant dock */}
        <section className="space-y-3">
          <div className="hidden sm:block text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Try asking
          </div>
          <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2">
            {STARTER_QUESTIONS.map((q) => (
              <button
                key={q}
                onClick={() => dockController.newAndSend(q)}
                className="flex w-full sm:w-auto sm:inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm text-foreground hover:border-foreground/30 hover:shadow-sm transition-all"
              >
                <Sparkles className="size-3.5 text-muted-foreground shrink-0" />
                <span className="flex-1 text-left sm:flex-none">{q}</span>
                <ArrowRight className="size-3.5 text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>
        </section>

        {/* Featured action — climax. Inline the copy; edit this HTML freely. */}
        <section>
          <div
            className="rounded-2xl p-7 relative overflow-hidden"
            style={{
              background:
                'linear-gradient(135deg, color-mix(in oklch, var(--primary) 96%, white) 0%, color-mix(in oklch, var(--primary) 88%, var(--accent) 12%) 100%)',
              color: 'var(--primary-foreground)',
            }}
          >
            <div
              className="absolute -right-16 -top-16 size-52 rounded-full opacity-20"
              style={{ background: 'var(--accent)' }}
            />
            <div className="relative">
              <div className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] opacity-80 mb-3">
                <Zap className="size-3.5" />
                Let the assistant handle it
              </div>
              <h3 className="display text-2xl font-semibold mb-2 leading-tight">
                Recover the northern shortage — ranked by model
              </h3>
              <p className="hidden sm:block text-sm opacity-85 leading-relaxed mb-5 max-w-2xl">
                The assistant identifies the 30 stores out of the top 5 SKUs,
                ranks the recovery moves (transfer from southern surplus,
                expedite from warehouse, substitute with available colorway),
                and drafts the transfer request. You review and approve —
                it records the action and watches it execute.
              </p>
              <p className="sm:hidden text-sm opacity-85 leading-relaxed mb-5">
                Identify shortfalls, rank recovery moves, draft requests —
                approve before anything ships.
              </p>
              <button
                onClick={() =>
                  dockController.openAndSend(FEATURED_ACTION_PROMPT)
                }
                className="inline-flex items-center gap-2 rounded-lg bg-white text-primary px-4 py-2 text-sm font-medium hover:shadow-sm transition-all"
              >
                <Brain className="size-4" />
                Run the analysis
              </button>
            </div>
          </div>
        </section>

        {/* Activity feed */}
        <ActivityFeed activity={activity} />
      </div>
    </div>
  );
}

/**
 * The "Today" daily brief hero. Nocturne card: Genie eyebrow, today's date,
 * a faint 4-point-star (compass) watermark, spotlight prose built from the
 * real position summary + worst open shortfall, a row of action chips that
 * open the chat dock, and an "ask anything" input.
 */
function DailyBrief({
  summary,
  worstShortfall,
  starters,
}: {
  summary: PositionSummary | null;
  worstShortfall: PositionRow | null;
  starters: string[];
}) {
  const [ask, setAsk] = useState('');

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });

  const open = summary?.openShortfalls ?? null;
  const inProgress = summary?.recoveriesInProgress ?? null;
  const worstProduct = worstShortfall?.productName ?? worstShortfall?.productId ?? null;
  const worstStore = worstShortfall?.storeId ?? null;

  const recoverWorstPrompt = worstStore
    ? `Store ${worstStore} is short on the ${worstProduct}. Investigate why, rank the recovery moves with the model (transfer vs expedite vs substitute), draft the transfer request, and wait for my approval before recording it.`
    : STARTER_QUESTIONS[0];

  const releasePrompt = `Release reorders for the ${open ?? ''} open shortfalls — rank each recovery move with the model and draft the requests for my approval.`;

  const chips: { label: string; prompt: string }[] = [];
  if (worstStore) {
    chips.push({ label: 'Recover the worst shortfall', prompt: recoverWorstPrompt });
  }
  if (open) {
    chips.push({ label: `Release ${open} reorders`, prompt: releasePrompt });
  }
  chips.push({ label: 'Where are we short vs over-stocked?', prompt: starters[0] });
  chips.push({ label: "What's the best recovery move?", prompt: starters[2] });

  const submitAsk = (e: React.FormEvent) => {
    e.preventDefault();
    const q = ask.trim();
    if (!q) return;
    dockController.openAndSend(q);
    setAsk('');
  };

  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-border p-6 sm:p-8"
      style={{
        background:
          'radial-gradient(120% 140% at 100% 0%, color-mix(in oklch, var(--accent) 14%, var(--card)) 0%, var(--card) 55%)',
      }}
    >
      {/* Faint compass / 4-point-star watermark, top-right. */}
      <svg
        className="pointer-events-none absolute -right-6 -top-8 size-48 opacity-[0.06]"
        viewBox="0 0 100 100"
        aria-hidden
        fill="var(--accent)"
      >
        <path d="M50 0 L58 42 L100 50 L58 58 L50 100 L42 58 L0 50 L42 42 Z" />
      </svg>

      <div className="relative space-y-5">
        {/* Eyebrow + date */}
        <div className="flex items-center justify-between gap-3">
          <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <img src="/brand/db/genie.svg" alt="" aria-hidden className="size-4" />
            Genie · Your daily brief
          </div>
          <div className="text-xs sm:text-sm font-medium text-muted-foreground shrink-0">
            {today}
          </div>
        </div>

        {/* Spotlight prose — real data, accent-highlighted key clauses. */}
        <p className="display text-xl sm:text-2xl lg:text-3xl leading-snug tracking-tight text-foreground max-w-3xl">
          {summary ? (
            <>
              Good morning.{' '}
              <span className="font-semibold" style={{ color: 'var(--np-short)' }}>
                {open} northern stores short on 5 cold-weather SKUs
              </span>{' '}
              —{' '}
              <span className="font-semibold" style={{ color: 'var(--np-short)' }}>
                {formatUsdCompact(summary.lostSalesExposureUsd)} lost-sales exposure
              </span>{' '}
              against a{' '}
              <span className="font-semibold" style={{ color: 'var(--np-long)' }}>
                {formatUsdCompact(summary.markdownExposureUsd)} markdown clock
              </span>
              .{' '}
              {worstStore ? (
                <>
                  Handle first:{' '}
                  <span className="font-semibold" style={{ color: 'var(--accent)' }}>
                    recover Store {worstStore} · {worstProduct}
                  </span>
                  .{' '}
                </>
              ) : null}
              You&apos;ve got{' '}
              <span className="font-semibold text-foreground">
                {inProgress} recoveries in progress
              </span>{' '}
              below.
            </>
          ) : (
            <span className="text-muted-foreground">Loading your brief…</span>
          )}
        </p>

        {/* Action chips — each opens the chat dock. */}
        <div className="flex flex-wrap gap-2">
          {chips.map((c) => (
            <button
              key={c.label}
              onClick={() => dockController.openAndSend(c.prompt)}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/40 px-3.5 py-1.5 text-sm text-foreground hover:border-foreground/30 hover:bg-background/70 transition-all"
            >
              <span>{c.label}</span>
              <ArrowRight className="size-3.5 text-muted-foreground shrink-0" />
            </button>
          ))}
        </div>

        {/* Ask anything input — submitting opens the dock with the typed text. */}
        <form
          onSubmit={submitAsk}
          className="flex items-center gap-2 rounded-xl border border-border bg-background/50 px-3.5 py-2.5 focus-within:border-foreground/30 transition-colors max-w-2xl"
        >
          <Sparkles className="size-4 text-muted-foreground shrink-0" />
          <input
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            placeholder="Ask anything about your store…"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          <button
            type="submit"
            disabled={!ask.trim()}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-40 transition-opacity"
            style={{ background: 'var(--primary)' }}
            aria-label="Ask the assistant"
          >
            <CornerDownLeft className="size-3.5" />
          </button>
        </form>
      </div>
    </section>
  );
}

/**
 * "Jump into a module" — the app's real modules, each with a live signal +
 * status dot. Routes via NavLink. Reorders is the new write-back surface,
 * which lives on the Operations page, so it links there too.
 */
function ModuleRow({ summary }: { summary: PositionSummary | null }) {
  const open = summary?.openShortfalls ?? null;
  const openLabel = open === null ? '—' : String(open);

  const modules = [
    {
      to: '/operations',
      icon: PackageOpen,
      title: 'Operations',
      signal: `${openLabel} shortfalls open`,
      dot: open && open > 0 ? 'var(--np-short)' : 'var(--muted-foreground)',
    },
    {
      to: '/operations',
      icon: RotateCcw,
      title: 'Reorders',
      signal: `${openLabel} to release`,
      dot: open && open > 0 ? 'var(--np-long)' : 'var(--muted-foreground)',
    },
    {
      to: '/analytics',
      icon: BarChart3,
      title: 'Analytics',
      signal: 'trends',
      dot: 'var(--accent)',
    },
    {
      to: '/dashboard',
      icon: LayoutDashboard,
      title: 'Dashboard',
      signal: 'live',
      dot: 'var(--accent)',
    },
  ];

  return (
    <section className="space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        Jump into a module
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {modules.map((m) => {
          const Icon = m.icon;
          return (
            <NavLink
              key={m.title}
              to={m.to}
              className="group rounded-2xl border border-border bg-card p-4 hover:border-foreground/25 hover:shadow-sm transition-all flex flex-col gap-3"
            >
              <div className="flex items-center justify-between">
                <div
                  className="size-9 rounded-lg flex items-center justify-center shrink-0"
                  style={{
                    background: 'color-mix(in oklch, var(--accent) 16%, transparent)',
                    color: 'var(--accent)',
                  }}
                >
                  <Icon className="size-5" />
                </div>
                <span
                  className="size-2 rounded-full shrink-0"
                  style={{ background: m.dot }}
                  aria-hidden
                />
              </div>
              <div>
                <div className="font-semibold text-sm text-foreground">{m.title}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{m.signal}</div>
              </div>
            </NavLink>
          );
        })}
      </div>
    </section>
  );
}

function JourneyDiagram({
  heroName,
  script,
}: {
  heroName: string;
  script: ScriptStep[];
}) {
  const steps = [
    {
      icon: Eye,
      title: `${heroName} opens Operations`,
      description: 'The shortfall queue is waiting. Store map glowing red.',
      action: () => {
        // const nav = useNavigate() won't work here; we'd need to refactor.
        // For now, just show a note that clicking navigates.
        window.location.hash = '#/operations';
      },
      actionLabel: 'Navigate',
    },
    {
      icon: MessageCircleQuestion,
      title: `${heroName} asks the assistant`,
      description:
        'Why is Store 214 out of stock on the Parka? The AI digs into velocity, replenishment, regional demand.',
      action: () => {
        dockController.newAndSend(script[0]?.prompt ?? STARTER_QUESTIONS[0]);
      },
      actionLabel: script[0]?.label ?? 'Ask',
    },
    {
      icon: Brain,
      title: 'AI ranks the recovery move',
      description:
        'Transfer from Store 387 in the South (best net value). Expedite from warehouse (faster). Substitute nearby colorway.',
      action: () => {
        dockController.open();
      },
      actionLabel: 'View ranking',
    },
    {
      icon: CheckCircle2,
      title: `${heroName} approves the transfer`,
      description: 'Done. Units ship from Store 387 to Store 214 by tomorrow.',
      action: () => {
        dockController.openAndSend(
          script[1]?.prompt ??
            'Record the transfer from Store 387 to Store 214.',
        );
      },
      actionLabel: script[1]?.label ?? 'Record',
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {steps.map((step, i) => {
        const Icon = step.icon;
        return (
          <Fragment key={i}>
            <div className="rounded-2xl border-2 border-border bg-card p-5 space-y-4 flex flex-col">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <div
                    className="size-8 rounded-lg flex items-center justify-center shrink-0"
                    style={{
                      background: 'var(--primary)',
                      color: 'var(--primary-foreground)',
                    }}
                  >
                    <Icon className="size-5" />
                  </div>
                  <div className="font-semibold text-sm leading-tight">
                    {step.title}
                  </div>
                </div>
                <div className="text-xs font-bold text-muted-foreground">
                  {i + 1}
                </div>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed flex-1">
                {step.description}
              </p>
              <button
                onClick={step.action}
                className="text-xs font-semibold text-primary hover:text-primary/80 transition-colors inline-flex items-center gap-1"
              >
                {step.actionLabel}
                <ArrowRight className="size-3" />
              </button>
            </div>
            {i < steps.length - 1 && (
              <div className="hidden lg:flex items-center justify-center">
                <ArrowRight className="size-5 text-muted-foreground" />
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function ActivityFeed({ activity }: { activity: ActivityEvent[] }) {
  if (activity.length === 0) {
    return null;
  }

  return (
    <section className="space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        Recent activity
      </div>
      <div className="space-y-2">
        {activity.slice(0, 5).map((event, i) => (
          <ActivityBody key={i} event={event} />
        ))}
      </div>
    </section>
  );
}

function ActivityBody({ event }: { event: ActivityEvent }) {
  if (event.kind !== 'action') return null;

  const moveLabel = {
    transfer: 'Transfer',
    expedite: 'Expedite',
    substitute: 'Substitute',
    markdown_hold: 'Markdown hold',
    reorder: 'Reorder',
  }[event.move_type];

  const at = new Date(event.at);
  const now = new Date();
  const diffMs = now.getTime() - at.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  let timeStr = 'just now';
  if (diffMins >= 1) timeStr = `${diffMins}m ago`;
  if (diffHours >= 1) timeStr = `${diffHours}h ago`;
  if (diffDays >= 1) timeStr = `${diffDays}d ago`;

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
      <div className="flex items-start gap-3">
        <div className="text-muted-foreground shrink-0 mt-0.5 w-4">
          <Wrench className="size-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-foreground">
            {moveLabel} {event.units} units · Store {event.store_id}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {event.status} by {event.by} · {timeStr}
            {event.predicted_recaptured_usd && (
              <> · predicted +${event.predicted_recaptured_usd.toLocaleString()}</>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

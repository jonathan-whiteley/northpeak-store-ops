/**
 * Floating "Thinking" panel (bottom-left, drag-from-header) — the visible
 * proof that the agent is working, not just spinning. Drag the header to
 * reposition; the panel stays where the user drops it for the rest of the
 * session (no persistence — fresh load resets to bottom-left).
 *
 * Template intent: a long agent turn (reasoning + tool hops + MAS calls)
 * can take 30–120s. Without visual feedback the user thinks the app froze.
 * This panel streams three kinds of live events in the order they arrive:
 *
 *   - `tool_call`   → `🔧 tool_name` with args (incl. `mas:sub_agent`
 *                     when the outer agent delegates to the MAS and we
 *                     bubble up sub-agent activity via `onToolProgress`)
 *   - `tool_output` → nested under the matching tool_call (by call_id);
 *                     pipe-delimited tables get rendered as real tables
 *   - `reasoning_stream` / `intermediate_message` → the model's reasoning
 *                     summary tokens (Responses API) — live cursor while
 *                     streaming, then replaced with the authoritative text
 *
 * Persisted on the assistant message so "▸ Reasoning · N tools" still
 * works on reload. `ThinkingEventList` is the same renderer, used both
 * here (floating, live) and inline (on past messages).
 */
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Spinner } from '@databricks/appkit-ui/react';

export type ThinkingEvent =
  | { kind: 'tool_call'; callId: string; name: string; args: string }
  | { kind: 'tool_output'; callId: string; output: string }
  | { kind: 'intermediate_message'; text: string }
  /** Genie "show your work": the generated SQL + result grid. Rendered as a
   *  Generated-SQL block + a grain-adaptive results table (+ optional
   *  highlight callout). Persisted so reload re-renders it. */
  | { kind: 'genie_result'; sql: string | null; columns: string[]; rows: unknown[][] }
  /** Live-streaming reasoning summary (Responses API). Accumulated in-place
   *  by appending deltas; once the `done` event arrives, this entry is
   *  replaced with an `intermediate_message` carrying the authoritative text. */
  | { kind: 'reasoning_stream'; text: string };

/** Inline renderer: just the merged event rows. No header, no close, no float. */
export function ThinkingEventList({ events }: { events: ThinkingEvent[] }) {
  const merged = mergeToolCalls(events);
  if (merged.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic">
        No reasoning steps captured.
      </div>
    );
  }
  return (
    <div className="space-y-3 text-xs">
      {merged.map((e, i) => (
        <ThinkingEventRow key={i} event={e} />
      ))}
    </div>
  );
}

type Props = {
  events: ThinkingEvent[];
  streaming: boolean;
  completed: boolean;
  onClose: () => void;
};

// Anchor: bottom-left, 20px in from each edge. The panel uses a fixed
// target height (clamped against the viewport) so it's always tall — the
// inner event list is scrollable + auto-sticks to the latest event.
const EDGE_MARGIN = 20;
const PANEL_TARGET_HEIGHT = 360;

function defaultPosition(): { left: number; top: number } {
  // Anchor at bottom-left: top = viewportHeight - panelHeight - margin.
  // Computed once on mount; if the user resizes the window the panel keeps
  // its current top (drag to reposition). Reload snaps back to bottom-left.
  if (typeof window === 'undefined') return { left: EDGE_MARGIN, top: EDGE_MARGIN };
  const h = Math.min(PANEL_TARGET_HEIGHT, window.innerHeight - EDGE_MARGIN * 2);
  return {
    left: EDGE_MARGIN,
    top: Math.max(EDGE_MARGIN, window.innerHeight - h - EDGE_MARGIN),
  };
}

// Auto-dismiss timing: wait `AUTO_DISMISS_DELAY_MS` after the turn
// completes, then fade out over `FADE_DURATION_MS`, then unmount. The
// timeline overlaps so the panel stays mounted for the full fade.
const AUTO_DISMISS_DELAY_MS = 3000;
const FADE_DURATION_MS = 600;

export function ThinkingPanel({ events, streaming, completed, onClose }: Props) {
  const [autoDismissed, setAutoDismissed] = useState(false);
  const [fadingOut, setFadingOut] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // "Stuck to bottom" — auto-scroll on new events. Flips off when the user
  // scrolls up manually, flips back on when they scroll back to the bottom.
  const stickRef = useRef(true);

  // Position + drag state. Default bottom-left; user can drag from the header
  // to reposition. Position resets on full page reload (no localStorage —
  // demo lifetime only; reset between presentations is the desired default).
  const [pos, setPos] = useState<{ left: number; top: number }>(defaultPosition);
  const dragOffset = useRef<{ dx: number; dy: number } | null>(null);

  function onHeaderPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Ignore clicks on the close button (and any other interactive child).
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    dragOffset.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onHeaderPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragOffset.current) return;
    const { dx, dy } = dragOffset.current;
    // Clamp inside the viewport using the panel's actual rendered width/height
    // (read from the header's parent) so the drag can't push it off-screen.
    const panel = e.currentTarget.parentElement!;
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const maxLeft = Math.max(0, window.innerWidth - w);
    const maxTop = Math.max(0, window.innerHeight - h);
    setPos({
      left: Math.min(maxLeft, Math.max(0, e.clientX - dx)),
      top: Math.min(maxTop, Math.max(0, e.clientY - dy)),
    });
  }
  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragOffset.current) return;
    dragOffset.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  useEffect(() => {
    if (!completed) {
      // New turn started — reset both fade flags so the panel snaps back.
      setAutoDismissed(false);
      setFadingOut(false);
      return;
    }
    // Two-phase dismiss so the user sees the panel fade out instead of
    // disappearing. Phase 1: trigger CSS opacity transition. Phase 2:
    // unmount after the transition completes.
    const fadeTimer = setTimeout(() => setFadingOut(true), AUTO_DISMISS_DELAY_MS);
    const unmountTimer = setTimeout(
      () => setAutoDismissed(true),
      AUTO_DISMISS_DELAY_MS + FADE_DURATION_MS,
    );
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(unmountTimer);
    };
  }, [completed]);

  // Autoscroll whenever the inner content grows, but only if we're "stuck".
  // Trigger on events.length AND on the last event's content, so a tool_call
  // gaining its tool_output (which merges into the same row, no length change)
  // still scrolls into view.
  const lastEventDigest =
    events.length > 0
      ? (events[events.length - 1] as { output?: string; text?: string; args?: string })?.output
        ?? (events[events.length - 1] as { text?: string }).text
        ?? (events[events.length - 1] as { args?: string }).args
        ?? ''
      : '';
  useEffect(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [events.length, lastEventDigest]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    // 40px tolerance so "close to the bottom" still counts as stuck.
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickRef.current = nearBottom;
  }

  if (!streaming && !events.length) return null;
  if (autoDismissed) return null;

  const merged = mergeToolCalls(events);

  return (
    <div
      className="fixed z-40 w-[clamp(420px,32vw,560px)]"
      style={{
        left: pos.left,
        top: pos.top,
        // Fixed target height clamped to viewport. The inner event list is
        // overflow-y-auto + auto-sticks to the bottom (latest event), so a
        // tall panel keeps the most recent reasoning/tool calls visible
        // without forcing the user to scroll.
        height: `min(${PANEL_TARGET_HEIGHT}px, calc(100vh - ${EDGE_MARGIN * 2}px))`,
        // Fade out on auto-dismiss: opacity → 0 + slight downward drift.
        opacity: fadingOut ? 0 : 1,
        transform: fadingOut ? 'translateY(8px)' : 'translateY(0)',
        transition: `opacity ${FADE_DURATION_MS}ms ease-out, transform ${FADE_DURATION_MS}ms ease-out`,
        pointerEvents: fadingOut ? 'none' : 'auto',
      }}
    >
      <div
        className="flex h-full flex-col overflow-hidden rounded-xl border border-border/80 shadow-xl"
        style={{
          background: 'color-mix(in oklch, var(--card) 92%, transparent)',
          backdropFilter: 'blur(14px)',
        }}
      >
        <div
          className="flex items-center justify-between border-b border-border/60 px-4 py-2.5 shrink-0 cursor-grab active:cursor-grabbing select-none"
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          title="Drag to reposition"
        >
          <div className="flex items-center gap-2 text-sm">
            {streaming && !completed ? <Spinner /> : null}
            <span className="font-semibold tracking-tight">
              {completed ? 'Reasoning complete' : 'Thinking…'}
            </span>
            <span className="text-xs text-muted-foreground">
              · {merged.length} {merged.length === 1 ? 'step' : 'steps'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-sm size-6 rounded-md hover:bg-muted inline-flex items-center justify-center transition-colors"
            aria-label="Close thinking panel"
          >
            ✕
          </button>
        </div>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-xs min-h-0"
        >
          {merged.map((e, i) => (
            <ThinkingEventRow key={i} event={e} />
          ))}
          {merged.length === 0 && (
            <div className="text-muted-foreground italic">Waiting for the agent…</div>
          )}
        </div>
      </div>
    </div>
  );
}

type MergedEvent =
  | { kind: 'tool'; name: string; args: string; output?: string }
  | { kind: 'intermediate_message'; text: string }
  | { kind: 'reasoning'; text: string; streaming: boolean }
  | { kind: 'genie'; sql: string | null; columns: string[]; rows: unknown[][] };

function mergeToolCalls(events: ThinkingEvent[]): MergedEvent[] {
  const out: MergedEvent[] = [];
  const callById = new Map<string, MergedEvent & { kind: 'tool' }>();
  for (const e of events) {
    if (e.kind === 'tool_call') {
      const merged: MergedEvent & { kind: 'tool' } = {
        kind: 'tool',
        name: e.name,
        args: e.args,
      };
      callById.set(e.callId, merged);
      out.push(merged);
    } else if (e.kind === 'tool_output') {
      const parent = callById.get(e.callId);
      if (parent) parent.output = e.output;
      else out.push({ kind: 'tool', name: '(unknown)', args: '', output: e.output });
    } else if (e.kind === 'intermediate_message') {
      out.push({ kind: 'reasoning', text: e.text, streaming: false });
    } else if (e.kind === 'reasoning_stream') {
      out.push({ kind: 'reasoning', text: e.text, streaming: true });
    } else if (e.kind === 'genie_result') {
      out.push({
        kind: 'genie',
        sql: e.sql,
        columns: e.columns,
        rows: e.rows,
      });
    }
  }
  return out;
}

function ThinkingEventRow({ event }: { event: MergedEvent }) {
  if (event.kind === 'genie') {
    return (
      <GenieResultCard sql={event.sql} columns={event.columns} rows={event.rows} />
    );
  }
  if (event.kind === 'reasoning') {
    // Sub-agent name tags: <name>agent_name</name>
    const nameTag = event.text.match(/^<name>(.+?)<\/name>$/);
    if (nameTag) {
      return (
        <div className="text-muted-foreground">
          <span className="inline-block px-1.5 py-0.5 rounded bg-muted font-mono">
            {nameTag[1]}
          </span>{' '}
          responded
        </div>
      );
    }
    return (
      <div className="flex gap-2">
        <div className="shrink-0 text-base leading-none mt-0.5">💭</div>
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
            Reasoning {event.streaming && <span className="animate-pulse">▍</span>}
          </div>
          <ReasoningMarkdown text={event.text} />
        </div>
      </div>
    );
  }
  if (event.kind === 'intermediate_message') {
    return (
      <div className="border-l-2 border-muted pl-2">
        <ReasoningMarkdown text={event.text} />
      </div>
    );
  }
  return (
    <div
      className="border-l-2 pl-3 space-y-1"
      style={{ borderColor: 'var(--accent)' }}
    >
      <div className="flex items-baseline gap-1.5">
        <span className="font-semibold text-foreground">🔧 {event.name}</span>
        {event.output === undefined && (
          // In-flight: matched tool_output hasn't arrived yet. The
          // dispatcher fires tool_call immediately, then the long-running
          // tool (MAS stream, Genie poll, DB query) eventually fires
          // tool_output — so this spinner ticks while the call runs.
          <span
            aria-label="running"
            className="inline-block h-3 w-3 rounded-full border-2 border-muted-foreground/40 border-t-foreground animate-spin"
          />
        )}
      </div>
      {event.args && (
        <div className="font-mono whitespace-pre-wrap break-words text-muted-foreground">
          {truncate(prettyArgs(event.args), 300)}
        </div>
      )}
      {event.output !== undefined && (
        <details className="pt-1">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            output
          </summary>
          <ToolOutputBody text={event.output} />
        </details>
      )}
    </div>
  );
}

/**
 * Render reasoning / intermediate-message text as markdown so KA citations
 * from the MAS render cleanly. We:
 *   - Split off footnote-body blocks (`[^x-1]: …`) into a collapsible
 *     "Sources" disclosure so the main text stays readable.
 *   - Strip raw `<table>` blobs inside footnotes (noise — they repeat info
 *     that's already in the main text).
 *   - Collapse verbose PDF link labels to just the filename.
 * Links open in new tabs.
 */
function ReasoningMarkdown({ text }: { text: string }) {
  // Footnote refs `[^x-1]` are resolved by remark-gfm to numbered superscript
  // links ONLY if the matching `[^x-1]: ...` definitions are in the same
  // markdown pass. We used to split them into two passes which left the refs
  // as raw `[^x-1]` text in the body. Instead: clean noise (HTML tables)
  // from the whole text, render it in ONE pass, and hide the auto-generated
  // footnotes `<section>` by default behind a "Sources" toggle via CSS —
  // click "Sources" to reveal. This keeps superscript references working.
  const cleaned = cleanupNoise(text);
  const hasFootnotes = /^\s*\[\^[^\]]+\]:/m.test(cleaned);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  return (
    <div className={`space-y-1.5 ${sourcesOpen ? 'sources-open' : 'sources-closed'}`}>
      <MDBlock text={cleaned} />
      {hasFootnotes && (
        <button
          onClick={() => setSourcesOpen((s) => !s)}
          className="cursor-pointer text-[10px] uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground not-italic"
        >
          {sourcesOpen ? '▾ Sources' : '▸ Sources'}
        </button>
      )}
      <style>{`
        .sources-closed .footnotes { display: none; }
      `}</style>
    </div>
  );
}

function MDBlock({ text }: { text: string }) {
  return (
    <div className="prose prose-sm prose-neutral max-w-none break-words text-[12.5px] leading-[1.5] text-foreground/80 [&_p]:my-1.5 [&_p]:leading-[1.5] [&_p]:text-[12.5px] [&_a]:text-[var(--accent)] [&_a]:underline [&_a]:decoration-dotted [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_li]:leading-[1.5] [&_li]:text-[12.5px] [&_code]:text-[11px] [&_table]:text-[11px] [&_h1]:text-sm [&_h1]:my-2 [&_h2]:text-sm [&_h2]:my-2 [&_h3]:text-sm [&_h3]:my-2 [&_strong]:font-semibold italic">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => {
            const label = shortenLinkLabel(children, href);
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {label}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function cleanupNoise(text: string): string {
  // Drop raw <table>…</table> blocks the KA agent inlines — they duplicate
  // info already present as markdown elsewhere and render as HTML soup.
  return text.replace(/<table\b[\s\S]*?<\/table>/gi, '').replace(/\n{3,}/g, '\n\n');
}

function shortenLinkLabel(
  children: React.ReactNode,
  href: string | undefined,
): React.ReactNode {
  // If the visible link text is one absurdly long URL fragment (PDF
  // deep-link with `#page=N:~:text=…`), swap it for the file basename.
  const asString =
    typeof children === 'string'
      ? children
      : Array.isArray(children)
        ? children.join('')
        : null;
  if (!href || !asString) return children;
  if (asString.length < 80) return children;
  // Pull filename from the href (before any #).
  try {
    const u = new URL(href);
    const name = u.pathname.split('/').pop();
    if (name) return name;
  } catch {
    /* fall through */
  }
  return asString.slice(0, 60) + '…';
}

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function prettyArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * Tool outputs are often pipe-delimited tables from genie_query. When we
 * detect the MAS shape (leading `||` on every row), we normalize it into
 * GFM-compatible markdown and render it with react-markdown. Otherwise we
 * fall back to monospace truncation.
 */
function ToolOutputBody({ text }: { text: string }) {
  const md = tryNormalizeTable(text);
  if (md) {
    return (
      <div className="pt-1 max-h-72 overflow-auto rounded border border-border/60 bg-background/50 px-2 py-1.5 prose prose-xs prose-neutral max-w-none [&_table]:text-[11px] [&_th]:bg-muted [&_th]:font-semibold [&_td]:py-0.5 [&_th]:py-0.5 [&_td]:px-1.5 [&_th]:px-1.5">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
      </div>
    );
  }
  return (
    <div className="font-mono whitespace-pre-wrap break-words text-muted-foreground pt-1 max-h-60 overflow-auto">
      {truncate(text, 1200)}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Genie "show your work" — SQL block + grain-adaptive results table.
// Ported from the reference geniePanel.jsx `buildTable()` heuristic and
// re-skinned to nocturne tokens. Given the raw {columns, rows} the Genie
// query returned, it: hides id columns, picks a name-like label column,
// colors a status dot, and formats hours / % / counts / $ / scores per the
// header name. Purely presentational — no data is invented.
// ────────────────────────────────────────────────────────────────────────

const GENIE_MAX_ROWS = 8;

// Nocturne status → dot color. Mirrors --np-short / --np-long / --pos-healthy.
const GENIE_STATUS_COLORS: Record<string, string> = {
  stockout: 'var(--np-short)',
  at_risk: '#ff8a4c',
  overstock: 'var(--np-long)',
  healthy: 'var(--pos-healthy)',
  // Reference domain values kept so cross-domain Genie answers still color.
  understaffed: 'var(--np-short)',
  overstaffed: 'var(--np-long)',
  balanced: 'var(--success)',
};
const GENIE_STATUS_VALUES = new Set(Object.keys(GENIE_STATUS_COLORS));
const GENIE_NEUTRAL_DOT = 'var(--pos-healthy)';

function genieStatusColor(val: unknown): string | null {
  if (val == null) return null;
  const key = String(val).toLowerCase().trim();
  return GENIE_STATUS_COLORS[key] ?? null;
}

function round1(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// snake_case → Title Case, stripping a trailing _id. Leaves already-pretty
// headers (with a space or uppercase) alone.
function prettyHeader(name: string): string {
  if (/[A-Z ]/.test(name)) return name;
  const stripped = name.replace(/_id$/i, '');
  return stripped
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// Format one cell value given its ORIGINAL (pre-prettify) column name.
function formatCell(origHeader: string, value: unknown): string {
  if (value == null) return '';
  const h = String(origHeader);
  const isNumericStr =
    typeof value === 'string' &&
    /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim());
  if (typeof value === 'string' && !isNumericStr) return value;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (Number.isNaN(n)) return String(value);

  // Currency-like: usd / exposure / recaptured / price / value / cost / revenue
  if (/usd|exposure|recaptured|price|value|cost|revenue|sales|\$/i.test(h)) {
    return `$${new Intl.NumberFormat('en-US', {
      notation: Math.abs(n) >= 10000 ? 'compact' : 'standard',
      maximumFractionDigits: Math.abs(n) >= 10000 ? 1 : 0,
    }).format(n)}`;
  }
  // Distance (km / mi)
  if (/distance|_km\b|_mi\b/i.test(h)) return `${round1(n)}${/_mi\b/i.test(h) ? 'mi' : 'km'}`;
  // Weeks of supply
  if (/weeks?_of_supply|\bwos\b|weeks/i.test(h)) return `${round1(n)}w`;
  // Percent / rate / share
  if (/pct|percent|rate|share/i.test(h)) {
    const base = `${round1(n)}%`;
    return /delta|gap|change|diff/i.test(h) && n > 0 ? `+${base}` : base;
  }
  // Score / probability / risk / index → fixed 2 decimals (no sci notation)
  if (/score|probability|\bprob\b|risk|index/i.test(h)) return n.toFixed(2);
  // Count-like: units / on_hand / on_order / velocity / count / visits
  if (/unit|on_hand|on_order|velocity|count|visits?|qty|quantity/i.test(h)) {
    return Math.round(n).toLocaleString('en-US');
  }
  return round1(n);
}

type GenieTable = {
  h0: string;
  hrest: string[];
  rows: Array<{ name: string; vals: string[]; dot: string | null }>;
  callout: { label: string; text: string } | null;
};

// Build the display table from raw Genie {columns, rows}. Returns null when
// there's nothing tabular to show (the caller then renders SQL-only or text).
function buildGenieTable(columns: string[], rows: unknown[][]): GenieTable | null {
  if (!columns.length || !rows.length) return null;

  const idRe = /^id$|_id$/i;
  let displayIdx = columns.map((_, i) => i).filter((i) => !idRe.test(columns[i]));
  if (displayIdx.length === 0) displayIdx = [0];

  const nameLikeRe = /name|store|product|sku|daypart|label|title|zip|neighborhood|category|city|region|zone/i;
  const capped = rows.slice(0, GENIE_MAX_ROWS);

  const isNonNumericCol = (ci: number) =>
    capped.some((r) => {
      const v = r[ci];
      if (v == null) return false;
      if (typeof v === 'number') return false;
      return Number.isNaN(Number(v));
    });

  const nonNumericDisplayed = displayIdx.filter(isNonNumericCol);
  let labelIdx: number;
  if (nonNumericDisplayed.length > 0) {
    const preferred = nonNumericDisplayed.find((i) => nameLikeRe.test(columns[i]));
    labelIdx = preferred !== undefined ? preferred : nonNumericDisplayed[0];
  } else {
    labelIdx = displayIdx[0];
  }

  // Status column: by name, else by value membership.
  let statusIdx: number | null = null;
  for (const ci of displayIdx) {
    if (/status/i.test(columns[ci])) {
      statusIdx = ci;
      break;
    }
    const hasStatusVal = capped.some((r) => {
      const v = r[ci];
      return v != null && GENIE_STATUS_VALUES.has(String(v).toLowerCase().trim());
    });
    if (hasStatusVal) {
      statusIdx = ci;
      break;
    }
  }

  const valueIdx = displayIdx.filter((i) => i !== labelIdx);
  const h0 = prettyHeader(columns[labelIdx]);
  const hrest = valueIdx.map((i) => prettyHeader(columns[i]));

  const tableRows = capped.map((r) => ({
    name: String(r[labelIdx] ?? ''),
    vals: valueIdx.map((i) => formatCell(columns[i], r[i])),
    dot: statusIdx !== null ? genieStatusColor(r[statusIdx]) ?? GENIE_NEUTRAL_DOT : null,
  }));

  // Optional honest highlight: the first (top-ranked, per the SQL's ORDER BY)
  // row's label + its leading value column. Factual, not a recommendation.
  let callout: GenieTable['callout'] = null;
  if (tableRows.length > 0 && valueIdx.length > 0 && tableRows[0].name) {
    callout = {
      label: tableRows[0].name,
      text: `${hrest[0]}: ${tableRows[0].vals[0]}`,
    };
  }

  return { h0, hrest, rows: tableRows, callout };
}

function GenieResultCard({
  sql,
  columns,
  rows,
}: {
  sql: string | null;
  columns: string[];
  rows: unknown[][];
}) {
  const table = buildGenieTable(columns, rows);
  if (!sql && !table) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
        <span className="text-sm leading-none">✨</span> Genie · queried the lakehouse
      </div>

      {/* Generated SQL block */}
      {sql && (
        <div
          className="rounded-md border border-border overflow-x-auto"
          style={{ background: 'var(--background)' }}
        >
          <div
            className="px-2.5 pt-1.5 text-[9px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: 'var(--accent)' }}
          >
            Generated SQL
          </div>
          <pre className="m-0 px-2.5 pb-2 pt-1 font-mono text-[10.5px] leading-[1.5] text-foreground/90 whitespace-pre">
            {sql.trim()}
          </pre>
        </div>
      )}

      {/* Results table */}
      {table && (
        <div className="rounded-md border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr style={{ background: 'var(--muted)' }}>
                  <th className="text-left font-semibold uppercase tracking-[0.04em] text-muted-foreground px-2.5 py-1.5 whitespace-nowrap">
                    {table.h0}
                  </th>
                  {table.hrest.map((h, i) => (
                    <th
                      key={i}
                      className="text-right font-semibold uppercase tracking-[0.04em] text-muted-foreground px-2.5 py-1.5 whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, i) => (
                  <tr
                    key={i}
                    className="border-t border-border/60"
                    style={{
                      background:
                        i % 2 ? 'transparent' : 'color-mix(in srgb, var(--muted) 40%, transparent)',
                    }}
                  >
                    <td className="px-2.5 py-1.5 font-medium text-foreground whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        {row.dot && (
                          <span
                            className="inline-block size-1.5 rounded-full shrink-0"
                            style={{ background: row.dot }}
                          />
                        )}
                        <span className="truncate max-w-[160px]">{row.name}</span>
                      </span>
                    </td>
                    {row.vals.map((v, j) => (
                      <td
                        key={j}
                        className="px-2.5 py-1.5 text-right font-mono text-foreground/85 whitespace-nowrap"
                      >
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > table.rows.length && (
            <div className="px-2.5 py-1 text-[10px] text-muted-foreground border-t border-border/60">
              +{rows.length - table.rows.length} more rows
            </div>
          )}
        </div>
      )}

      {/* Optional highlight callout — factual top row from the result grid */}
      {table?.callout && (
        <div
          className="flex items-start gap-2 rounded-md px-2.5 py-1.5"
          style={{
            background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
            borderLeft: '3px solid var(--accent)',
          }}
        >
          <span className="text-xs leading-none mt-0.5">⚡</span>
          <div className="text-[11.5px] leading-[1.45] text-foreground/90">
            <b style={{ color: 'var(--accent)' }}>{table.callout.label} </b>
            <span className="text-muted-foreground">· {table.callout.text}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function tryNormalizeTable(s: string): string | null {
  // MAS genie tables look like:
  //   ||col_a|col_b|col_c|
  //   |-|-|-|-|
  //   |0|foo|bar|baz|
  // That's ALMOST GFM except for the leading `||` on header row and the
  // extra "row index" column. Strip the leading `|` from each line so
  // remark-gfm parses it as a normal markdown table.
  const lines = s.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  const first = lines[0].trim();
  if (!first.startsWith('||') || !first.endsWith('|')) return null;
  // Cap rendered rows so massive tables don't blow out the panel.
  const MAX_ROWS = 30;
  const body = lines.slice(2); // skip header + separator
  const truncated = body.length > MAX_ROWS;
  const shown = truncated ? body.slice(0, MAX_ROWS) : body;
  const normalized = [
    lines[0].replace(/^\|/, ''), // drop one of the leading pipes
    lines[1].replace(/^\|/, ''),
    ...shown.map((r) => r.replace(/^\|/, '')),
  ].join('\n');
  return truncated
    ? `${normalized}\n\n_…and ${body.length - MAX_ROWS} more rows_`
    : normalized;
}

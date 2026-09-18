"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { transitionAction } from "@/app/actions";
import { type Transition, statusTone } from "@/lib/jira/types";

import { useNav } from "./navigation";

const TONE: Record<string, string> = {
  todo: "bg-surface-2 text-ink-2",
  prog: "bg-accent-soft text-accent-ink",
  test: "bg-warn-soft text-warn",
  ver: "bg-blue-soft text-blue",
  done: "bg-good-soft text-good",
};

/**
 * Status shown as a pill; the transition list is fetched on first open.
 *
 * Transitions are per-issue and per-workflow, so a board of twenty rows would
 * otherwise need twenty requests before it could render. Loading on demand
 * trades a brief wait on click for a board that appears immediately.
 */
export function StatusPill({
  issueKey,
  statusName,
  onChanged,
  compact = false,
  readOnly = false,
  readOnlyReason,
}: {
  issueKey: string;
  statusName: string;
  onChanged?: (name: string) => void;
  /** Caps the width on the one-line board row so long statuses cannot push it wide. */
  compact?: boolean;
  /** Renders the status as a plain label — someone else's task is not ours to move. */
  readOnly?: boolean;
  readOnlyReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  /**
   * Where to draw the menu, in viewport coordinates.
   *
   * Absolute positioning put the menu inside the card, and a kanban card sits
   * in two clipping ancestors — the card's own `overflow-hidden` and the
   * board's horizontal scroller — so the menu was cut off rather than covering
   * what it needed to. Anchoring to the viewport steps outside both.
   */
  const [at, setAt] = useState<{
    top: number;
    left: number;
    up: boolean;
  } | null>(null);
  const [items, setItems] = useState<Transition[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The status this pill shows.
   *
   * `statusName` is the server's answer and wins whenever it changes; the local
   * value only covers the moment between choosing a transition and the refetch
   * landing. Seeding state from the prop and never looking at it again — which
   * is what this was — froze the pill at whatever the page first rendered, so a
   * ticket moved anywhere else stayed wrong until a full reload. That is why
   * the board seemed to need a GitHub scan to notice Jira.
   */
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [lastSeen, setLastSeen] = useState(statusName);
  if (statusName !== lastSeen) {
    setLastSeen(statusName);
    setOptimistic(null);
  }
  const current = optimistic ?? statusName;
  const [pending, startTransition] = useTransition();
  const { refresh } = useNav();

  function place() {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    // Flip above the pill when there is not room below it — the menu is 256px
    // tall at most, and a card near the bottom of a column has none.
    const below = window.innerHeight - r.bottom;
    // Decided once. Written twice, the two copies had to be kept identical for
    // `top` to mean what `up` says it means.
    const up = below < 272 && r.top > below;
    setAt({
      top: up ? r.top - 4 : r.bottom + 4,
      left: Math.min(r.left, Math.max(8, window.innerWidth - 232)),
      up,
    });
  }

  // A viewport-anchored menu does not move with its button, so it is re-placed
  // on every scroll rather than closed. Closing was the first attempt and it
  // was wrong twice over: one notch of the wheel dismissed a menu the user was
  // reading, and a wheel over the menu's own list — which scrolls, there are
  // more transitions than fit — dismissed it while they were scrolling it.
  useEffect(() => {
    if (!open) return;
    // Coalesced into a frame: scroll fires many times per frame during
    // momentum scrolling, and each call measures the pill — a forced layout —
    // and sets state.
    let frame = 0;
    const follow = (e: Event) => {
      if (
        e.target instanceof Node &&
        menu.current?.contains(e.target) &&
        e.type === "scroll"
      ) {
        return;
      }
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const r = btn.current?.getBoundingClientRect();
        // Only once the pill itself is off-screen is there nothing left to
        // point at, and then the menu goes with it.
        if (!r || r.bottom < 0 || r.top > window.innerHeight)
          return setOpen(false);
        place();
      });
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [open]);

  async function toggle() {
    if (open) return setOpen(false);
    place();
    setOpen(true);
    if (items || loading) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/jira/transitions?key=${encodeURIComponent(issueKey)}`,
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Không lấy được transition");
      setItems(body.transitions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không lấy được transition");
    } finally {
      setLoading(false);
    }
  }

  function choose(t: Transition) {
    setOpen(false);
    startTransition(async () => {
      const res = await transitionAction(issueKey, t.id, t.toStatusName);
      if (res.ok) {
        setOptimistic(t.toStatusName);
        onChanged?.(t.toStatusName);
        // The list depends on the new status, so force a refetch next open.
        setItems(null);
        refresh();
      } else {
        setError(res.message);
      }
    });
  }

  // A plain span, not a disabled button: a greyed-out control invites clicking
  // and reads as broken, while the status itself is still worth showing.
  if (readOnly) {
    return (
      <span
        title={readOnlyReason ?? current}
        className={
          "inline-flex items-center gap-1 rounded-[4px] px-[6px] py-[3px] font-bold uppercase tracking-[0.05em] opacity-80 " +
          (compact ? "max-w-[192px] text-[9.5px]" : "text-[10px]") +
          " " +
          TONE[statusTone(current)]
        }
      >
        <span className="truncate">{current}</span>
        <em className="shrink-0 text-[8px] not-italic opacity-70">🔒</em>
      </span>
    );
  }

  return (
    <span className="relative inline-flex">
      <button
        ref={btn}
        type="button"
        onClick={toggle}
        disabled={pending}
        title={`${current} — bấm để đổi trạng thái`}
        className={
          "inline-flex items-center gap-1 rounded-[4px] px-[6px] py-[3px] font-bold uppercase tracking-[0.05em] disabled:opacity-60 " +
          (compact ? "max-w-[192px] text-[9.5px]" : "text-[10px]") +
          " " +
          TONE[statusTone(current)]
        }
      >
        {pending ? (
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <span className="inline-block size-2.5 animate-spin rounded-full border-[1.5px] border-current/30 border-t-current" />
            đang đổi…
          </span>
        ) : (
          <>
            <span className="truncate">{current}</span>
            <em className="shrink-0 text-[7px] not-italic opacity-70">▾</em>
          </>
        )}
      </button>

      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
            aria-label="Đóng"
          />
          <div
            ref={menu}
            style={
              at
                ? at.up
                  ? {
                      top: "auto",
                      bottom: window.innerHeight - at.top,
                      left: at.left,
                    }
                  : { top: at.top, left: at.left }
                : undefined
            }
            className="fixed z-40 flex max-h-64 min-w-[220px] flex-col overflow-y-auto rounded-md border border-line-strong bg-surface p-1 shadow-lg"
          >
            {loading && (
              <span className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] text-ink-3">
                <span className="inline-block size-3 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent" />
                Đang tải transition…
              </span>
            )}
            {error && (
              <span className="px-2 py-1.5 text-[12px] text-crit">{error}</span>
            )}
            {items?.length === 0 && (
              <span className="px-2 py-1.5 text-[12px] text-ink-3">
                Không có transition khả dụng
              </span>
            )}
            {items?.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => choose(t)}
                className="rounded px-2 py-1.5 text-left text-[12px] hover:bg-accent-soft hover:text-accent-ink"
              >
                {/* Jira's transition name can differ from the status it lands on,
                    so show the destination status — that is what the user means. */}
                {t.toStatusName}
                {t.name !== t.toStatusName && (
                  <span className="ml-1.5 text-[10.5px] text-ink-3">
                    ({t.name})
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}

      {error && !open && (
        <span className="ml-2 self-center text-[11px] text-crit">{error}</span>
      )}
    </span>
  );
}

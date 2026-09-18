"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useTransition,
} from "react";

/**
 * Shared navigation state for the board.
 *
 * Filter and date changes re-render the page on the server, which takes a
 * visible moment against Jira. Without a shared pending flag each control only
 * knows about its own transition, so the rest of the page looks frozen with no
 * explanation. This puts one flag where every part of the board can read it.
 */
const NavContext = createContext<{
  navigate: (href: string) => void;
  /** Re-fetches the route through the same shared pending flag. */
  refresh: () => void;
  pending: boolean;
}>({
  navigate: () => {},
  refresh: () => {},
  pending: false,
});

export function useNav() {
  return useContext(NavContext);
}

export function NavProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Memoised because consumers keep these: an interval keyed on `refresh`
  // identity was being torn down and restarted on every transition, so a
  // periodic refresh could never reach its own deadline.
  const navigate = useCallback(
    (href: string) => {
      startTransition(() => router.push(href));
    },
    [router],
  );

  /**
   * Used after a write. Routing it through the shared transition means the
   * progress bar, the dimmer and the inline spinners all react — otherwise the
   * side panels sit on stale numbers for the two or three seconds the refetch
   * takes, which reads as "the save did not work".
   */
  const refresh = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);

  const value = useMemo(
    () => ({ navigate, refresh, pending }),
    [navigate, refresh, pending],
  );

  return (
    <NavContext.Provider value={value}>
      {pending && <TopProgress />}
      {children}
    </NavContext.Provider>
  );
}

/** Indeterminate bar pinned to the top — the request length is unknown. */
function TopProgress() {
  return (
    <>
      <div className="fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-accent-soft">
        <div className="h-full w-1/3 animate-[nav-slide_1.1s_ease-in-out_infinite] bg-accent" />
      </div>
      <style>{`
        @keyframes nav-slide {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
        @media (prefers-reduced-motion: reduce) {
          .animate-\\[nav-slide_1\\.1s_ease-in-out_infinite\\] {
            animation: none;
            width: 100%;
            opacity: 0.6;
          }
        }
      `}</style>
    </>
  );
}

/**
 * Dims and freezes content while a navigation or refresh is in flight.
 *
 * `label` puts a word on top of the fade. Fading alone is ambiguous — after
 * logging hours, dimmed-but-unchanged numbers look the same as a failed save.
 */
export function NavDimmer({
  children,
  label,
}: {
  children: React.ReactNode;
  label?: string;
}) {
  const { pending } = useNav();
  return (
    <div className="relative">
      <div
        aria-busy={pending}
        className={
          "transition-opacity duration-150 " +
          (pending ? "pointer-events-none opacity-40" : "opacity-100")
        }
      >
        {children}
      </div>

      {pending && label && (
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
          <span className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11.5px] text-ink-2 shadow-sm">
            <span className="inline-block size-3 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent" />
            {label}
          </span>
        </div>
      )}
    </div>
  );
}

/** Inline "đang tải" chip for the filter bar. */
export function NavSpinner() {
  const { pending } = useNav();
  if (!pending) return null;
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11.5px] text-ink-3">
      <span className="inline-block size-3 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent" />
      đang tải…
    </span>
  );
}

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { usePathname, useRouter } from "next/navigation";

import {
  checkBuildsAction,
  markBuildsSeenAction,
} from "@/app/m/branches/actions";
import { type EnvBuild } from "@/lib/modules/branches/build-model";

const BTN =
  "rounded-md border border-line-strong bg-surface px-[9px] py-1 text-[12px] hover:bg-surface-2";

export interface BuildWatch {
  /** Builds that have landed and not been dismissed. */
  news: EnvBuild[];
  /** A hand-triggered check is in flight. */
  busy: boolean;
  /** What the last hand-triggered check said. '' when none has run. */
  note: string;
  permission: "unsupported" | NotificationPermission;
  requestPermission: () => void;
  /** Ask App Store Connect now, bypassing the five-minute read cache. */
  checkNow: () => void;
  /** Mark these builds read, here and in the database. */
  dismiss: (builds: EnvBuild[]) => void;
  /** Whether the background watch is switched on — not whether it is running. */
  watching: boolean;
}

const Ctx = createContext<BuildWatch | null>(null);

/**
 * The build check, from anywhere in the app.
 *
 * Null when the branches module is off, which is the only reason a consumer
 * ever needs to handle its absence — a page that offers a "check now" button
 * simply does not draw it.
 */
export function useBuildWatch(): BuildWatch | null {
  return useContext(Ctx);
}

/**
 * Watches the build channel for the whole app, and shows nothing for it.
 *
 * Two separate things, split here on purpose, because the first pass conflated
 * them and got told off for it:
 *
 *   - *Watching* has to outlive the branches board. A build lands while you
 *     are on the task board or in another tab entirely, which is exactly when
 *     a notification is worth having, so the timer runs from the layout.
 *   - *Showing* belongs to the module. A full-width green strip about iOS
 *     builds on top of Settings and the daily report is the module leaking out
 *     of itself; away from its own page the most this may spend is a dot on
 *     its own nav entry. The strip itself — {@link BuildNews} — is rendered by
 *     the board.
 *
 * One watcher, not one per page. Two would double the App Store Connect
 * traffic the moment somebody opened the branches board, and would race each
 * other to mark the same build as seen.
 *
 * The provider mounts whenever the module is on; `enabled` gates only the
 * timer and the browser notification. That keeps "↻ Bản build" working for a
 * team that switched the background watch off — asking on purpose is a
 * different thing from being told without asking.
 *
 * What it still cannot do is reach a closed browser. Nothing short of a push
 * subscription can, and that needs a server the user does not run — so the
 * honest boundary is "any tab of this app is open", and that is now what it is.
 */
export function BuildWatcher({
  enabled,
  watching,
  children,
}: {
  /** The module is on. Without it nothing here mounts at all. */
  enabled: boolean;
  /** The user wants the background watch — `buildNotify` in the module config. */
  watching: boolean;
  children: React.ReactNode;
}) {
  const [news, setNews] = useState<EnvBuild[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  /**
   * The browser's notification permission, as of the last time we looked.
   *
   * Seeded to "unsupported" because it cannot be read while rendering: the
   * server has no `Notification` at all, so a button drawn from it appears on
   * the client and not in the HTML, and React tears the tree down with a
   * hydration mismatch. The effect below fills in the real value after the
   * first paint, when server and client already agree.
   */
  const [permission, setPermission] = useState<
    "unsupported" | NotificationPermission
  >("unsupported");
  const [, startTx] = useTransition();
  const router = useRouter();
  const pathname = usePathname();
  /**
   * Read inside the tick without restarting it.
   *
   * The timer must not be torn down and rebuilt on every navigation — that
   * would reset the half-hour clock each time the user clicked a link, so a
   * browsing session would never reach a scheduled check at all.
   */
  const path = useRef(pathname);
  path.current = pathname;
  const checkRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (typeof Notification !== "undefined")
      setPermission(Notification.permission);
  }, []);

  /**
   * Tells the user a build landed, once, at the moment it lands.
   *
   * The strip below is the durable half — it survives a reload and waits until
   * it is dismissed. This is the half that reaches someone looking at another
   * tab, which is where they are while a build runs.
   */
  const announce = useCallback((list: EnvBuild[]) => {
    if (!list.length) return;
    if (
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    new Notification(
      list.length === 1
        ? `Có bản build mới cho ${list[0].branch}`
        : `${list.length} môi trường vừa có bản build`,
      {
        // The notes are the point of the notification: they say which tickets
        // the build carries, which is what the reader wants to know before
        // deciding whether to go and look.
        body: list
          .map((b) =>
            [`${b.branch} · ${b.build}`, b.notes].filter(Boolean).join("\n"),
          )
          .join("\n\n"),
        // One tag for all of it: several environments often build together, and
        // a banner each would be worse than none.
        tag: "branches-build",
      },
    );
  }, []);

  /**
   * Checks for new builds while any tab is open.
   *
   * Half an hour — twice an hour, chosen for the App Store Connect budget over
   * promptness. It costs about 0.3% of the 3600 an hour Apple allows, which the
   * `x-rate-limit` header reports on every call. Six minutes instead while a
   * build is uploaded but not yet handed to testers: that window is short and
   * is exactly when the board is wrong, because the "What to Test" note — the
   * only thing saying which tickets a build carries — is written at publish
   * time. Six rather than five, because the underlying list is cached for five
   * and a five-minute poll would keep reading the same cached answer.
   *
   * Deliberately runs whether or not the tab is in front. Skipping hidden tabs
   * defeats the point: the notification exists to reach someone looking at
   * something else, which is precisely when the tab is hidden. Browsers
   * throttle background timers to about a minute, which this does not notice.
   */
  /**
   * Fold one answer into the screen's state. Never announces — that is the
   * timer's job alone, and a check somebody pressed a button for does not need
   * a banner telling them what they just asked to see.
   */
  const take = useCallback(
    (res: Awaited<ReturnType<typeof checkBuildsAction>>) => {
      if (!res.ok) return;
      /**
       * Tagging writes the build number onto cards, so the page showing those
       * cards has to be re-read — but only that page. Refreshing the task board
       * instead would spend a Jira round trip to redraw something the build
       * check did not touch.
       */
      if (res.tagged && path.current.startsWith("/m/branches")) router.refresh();
      if (res.news) setNews(res.news);
    },
    [router],
  );

  /**
   * Checks for new builds while any tab is open.
   *
   * Half an hour — twice an hour, chosen for the App Store Connect budget over
   * promptness. It costs about 0.3% of the 3600 an hour Apple allows, which the
   * `x-rate-limit` header reports on every call. Six minutes instead while a
   * build is uploaded but not yet handed to testers: that window is short and
   * is exactly when the board is wrong, because the "What to Test" note — the
   * only thing saying which tickets a build carries — is written at publish
   * time. Six rather than five, because the underlying list is cached for five
   * and a five-minute poll would keep reading the same cached answer.
   *
   * Deliberately runs whether or not the tab is in front. Skipping hidden tabs
   * defeats the point: the notification exists to reach someone looking at
   * something else, which is precisely when the tab is hidden. Browsers
   * throttle background timers to about a minute, which this does not notice.
   *
   * Off entirely when the module's build watch is switched off — no timer, no
   * request, no permission prompt.
   */
  useEffect(() => {
    if (!enabled || !watching) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;

    const tick = () =>
      void checkBuildsAction().then((res) => {
        if (!alive) return;
        take(res);
        if (res.ok && res.news) announce(res.news);
        timer = setTimeout(tick, res.pending ? 6 * 60 * 1000 : 30 * 60 * 1000);
      });

    tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearTimeout(timer);
    };
  }, [enabled, watching, announce, take]);

  /**
   * The on-demand check, kept apart from the timer.
   *
   * Deliberately not gated on `watching`: switching the background watch off
   * says "do not tell me", not "do not let me look". A team that polls nothing
   * can still press the button on the day a build goes out.
   */
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    checkRef.current = () => {
      setBusy(true);
      void checkBuildsAction(true).then((res) => {
        if (!alive) return;
        setBusy(false);
        take(res);
        if (res.ok) setNote(res.message || "Chưa có bản build nào mới");
      });
    };
    return () => {
      alive = false;
      checkRef.current = null;
    };
  }, [enabled, take]);

  const dismiss = useCallback(
    (list: EnvBuild[]) => {
      const done = new Set(list.map((b) => `${b.branch}#${b.build}`));
      setNews((n) => n.filter((b) => !done.has(`${b.branch}#${b.build}`)));
      startTx(async () => {
        await markBuildsSeenAction(
          list.map((b) => ({ branch: b.branch, build: b.build })),
        );
      });
    },
    [startTx],
  );

  const value: BuildWatch | null = enabled
    ? {
        news,
        busy,
        note,
        permission,
        requestPermission: () =>
          void Notification.requestPermission().then(setPermission),
        checkNow: () => checkRef.current?.(),
        dismiss,
        watching,
      }
    : null;

  // Renders nothing of its own. Everything this knows is offered through the
  // context, and the module decides where — and whether — to draw it.
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Which environment and which build number, and nothing more.
 *
 * App Store Connect records nothing about branches, so a build cannot be
 * pinned to particular cards without guessing, and this is what is actually
 * known.
 *
 * Rendered by the branches board, not by the watcher. It briefly lived in the
 * layout and appeared on every screen in the app — Settings, the daily report,
 * the task board — which is a module putting its own business in front of
 * everybody else's work. Away from its own page the watcher spends a dot on
 * the nav entry and nothing more.
 *
 * Props rather than the context, so it stays a plain component that can be
 * placed anywhere the module owns.
 */
export function BuildNews({
  news,
  permission,
  onAllow,
  onDismiss,
}: {
  news: EnvBuild[];
  permission: "unsupported" | NotificationPermission;
  onAllow: () => void;
  onDismiss: () => void;
}) {
  return (
    <section className="mb-3 rounded-[9px] border border-good bg-good-soft/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.09em] text-good">
          Bản build mới
        </span>
        {news.map((b) => (
          <span
            key={`${b.branch}#${b.build}`}
            title={
              `${b.branch} · build ${b.build}` +
              (b.sha
                ? `\nTừ commit ${b.sha.slice(0, 8)}, run CI trên đúng nhánh này.`
                : `\nKhông khớp run CI nào — nhiều khả năng archive từ máy. Nhánh là suy ra từ app App Store Connect mà bản này upload lên.`) +
              `\n${new Date(b.at * 1000).toLocaleString("vi-VN")}` +
              (b.notes
                ? `\n\nNội dung bản build:\n${b.notes}`
                : b.externalState === "IN_BETA_TESTING"
                  ? `\n\nĐã public cho QC nhưng chưa ghi "What to Test", nên app không biết bản này chứa ticket nào.`
                  : `\n\nApple báo trạng thái ${b.externalState || "chưa rõ"} — mới upload, chưa public cho QC. "What to Test" được ghi lúc public nên giờ chưa có.`)
            }
            className="inline-flex min-w-0 items-baseline gap-1.5 rounded-[3px] border border-good bg-good-soft px-1.5 py-px font-mono text-[10px] text-good"
          >
            <span className="shrink-0 font-semibold">
              {b.branch} · {b.build}
              {!b.sha && " · từ máy"}
            </span>
            {/* What the build carries, straight from "What to Test". The strip
                is the only place the app says anything about a build's
                content, since it no longer claims which cards a build holds. */}
            <span className="min-w-0 truncate font-normal opacity-90">
              {b.notes
                ? b.notes.replace(/\s*\n\s*/g, " · ")
                : b.externalState === "IN_BETA_TESTING"
                  ? "đã public · chưa ghi nội dung"
                  : "chưa public cho QC"}
            </span>
          </span>
        ))}
        <span className="ml-auto flex items-center gap-2">
          {/* Only offered when it would do something. Asking for permission the
              browser has already refused just re-prints the same banner every
              visit. */}
          {permission === "default" && (
            <button
              type="button"
              onClick={onAllow}
              title="Cho phép hiện thông báo khi có bản build mới, kể cả khi bạn đang ở tab khác hoặc màn khác của app"
              className={BTN}
            >
              Bật thông báo
            </button>
          )}
          <button type="button" onClick={onDismiss} className={BTN}>
            Đã xem
          </button>
        </span>
      </div>
    </section>
  );
}

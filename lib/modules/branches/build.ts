import "server-only";

import { listApps, getProfile } from "@/lib/modules/ios-publish/config";
import { buildNotes, listBuilds } from "@/lib/modules/ios-publish/asc";

import { type EnvBuild, joinBuilds } from "./build-model";
import { fetchBuildRuns } from "./github";
import type { StageConfig } from "./model";

/**
 * How long a build reading is reused before Apple is asked again.
 *
 * App Store Connect allows 3600 requests an hour per team — it says so in the
 * `x-rate-limit` header — and this costs two per environment. That is not close
 * to the ceiling, but every open tab was paying it independently, so the cost
 * scaled with browser windows rather than with anything real.
 *
 * Five minutes rather than ten: the point of the check is to notice a build,
 * and a cache is dead time added to however long the poll already waits.
 */
const CACHE_MS = 5 * 60 * 1000;

/**
 * How many builds back to read notes for.
 *
 * A card's work may have shipped several builds ago, and only the note says so.
 * Eight covers a few days here without turning one check into a page of
 * requests — and the notes are cached below, so the depth is paid once rather
 * than every half hour.
 */
const NOTE_DEPTH = 8;

/** An environment the check could not read, and why — never a silent skip. */
export interface SkippedEnv {
  env: string;
  app: string;
  why: string;
}

let cache: {
  at: number;
  key: string;
  map: Map<string, EnvBuild[]>;
  skipped: SkippedEnv[];
} | null = null;

/**
 * Notes by App Store Connect build id, kept for the life of the process.
 *
 * A build's "What to Test" is written once, when it is published, and does not
 * change afterwards — re-reading it on every check would spend Apple's rate
 * limit to receive the same string back.
 *
 * Only a note that exists is cached. An empty one is not the final answer: it
 * means the build has been uploaded but not published yet, and caching that
 * forever meant a build read a minute too early would never show its tickets,
 * however long it sat there afterwards.
 */
const noteCache = new Map<string, string>();

async function notesFor(
  cred: Parameters<typeof buildNotes>[0],
  id: string,
): Promise<string> {
  if (!id) return "";
  const hit = noteCache.get(id);
  if (hit) return hit;
  const text = await buildNotes(cred, id).catch(() => "");
  if (text) noteCache.set(id, text);
  return text;
}

/**
 * What is currently installable, per environment.
 *
 * App Store Connect is asked what exists — it holds the build QC installs, and a
 * green workflow run whose artefact never uploaded would otherwise be reported
 * as shippable. GitHub is asked only which commit a build came from, when a run
 * can be matched to it.
 *
 * Credentials come from the iOS publish module rather than being configured
 * again here — they are the same App Store Connect keys, and a second copy is a
 * second thing to rotate.
 *
 * A workflow run is optional. Builds get archived from Xcode and uploaded by
 * hand here, and those are real builds QC installs; requiring a run would hide
 * every one of them. App Store Connect decides what exists, the run only says
 * which commit — see `build-model`.
 */
export async function fetchEnvBuilds(
  token: string,
  cfg: {
    buildWorkflow: string;
    buildRepo: string;
    buildApps: Record<string, string>;
  },
  envs: StageConfig[],
  /**
   * Ask Apple even if the cache is warm.
   *
   * For the one case the cache is wrong for: somebody knows a build just went
   * out and presses the button. Waiting out a five-minute cache to answer a
   * question the user asked on purpose is the cache working against its own
   * reason for existing.
   */
  fresh = false,
): Promise<{ builds: Map<string, EnvBuild[]>; skipped: SkippedEnv[] }> {
  const out = new Map<string, EnvBuild[]>();
  const skipped: SkippedEnv[] = [];
  if (!token || !cfg.buildWorkflow || !cfg.buildRepo)
    return { builds: out, skipped };

  // Keyed on the configuration so changing which app an environment publishes
  // under takes effect at once rather than after the cache expires.
  const key = JSON.stringify([cfg.buildRepo, cfg.buildWorkflow, cfg.buildApps]);
  if (!fresh && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    return { builds: new Map(cache.map), skipped: cache.skipped };
  }

  const presets = listApps();

  await Promise.all(
    envs.map(async (env) => {
      const appName = (cfg.buildApps[env.branch] ?? "").trim();
      // No app named for this environment is a deliberate blank, not a fault:
      // an environment nobody publishes from has no builds to find.
      if (!appName) return;

      const preset = presets.find(
        (a) => a.name.trim().toLowerCase() === appName.toLowerCase(),
      );
      const cred = preset ? getProfile(preset.profileId) : undefined;
      // Naming an app that iOS publish has no credential for is a fault, and
      // it used to fail in silence — the environment simply never produced a
      // build and nothing anywhere said why. A name with a typo in it, or an
      // app added to the pipeline but not to iOS publish, looked exactly like
      // "no builds yet" for ever.
      if (!cred) {
        skipped.push({
          env: env.branch,
          app: appName,
          why: preset
            ? `app "${appName}" có trong iOS publish nhưng profile của nó không mở được`
            : `app "${appName}" chưa có trong iOS publish — thêm ở đó rồi mới đọc được build`,
        });
        return;
      }

      const [runs, builds] = await Promise.all([
        fetchBuildRuns(
          token,
          cfg.buildRepo,
          cfg.buildWorkflow,
          env.branch,
        ).catch(() => []),
        listBuilds(cred, appName).catch(() => []),
      ]);
      if (!builds.length) return;

      const joined = joinBuilds(
        env.branch,
        runs,
        builds.map((b) => ({ version: b.version, uploadedAt: b.uploadedAt })),
      );
      if (!joined.length) return;

      // Notes for the recent ones, not merely the newest: a card's work may
      // have gone out several builds ago, and the note is the only record of
      // which build carried it.
      const byVersion = new Map(builds.map((b) => [b.version, b]));
      await Promise.all(
        joined.slice(0, NOTE_DEPTH).map(async (b) => {
          const src = byVersion.get(b.build);
          b.externalState = src?.externalState ?? "";
          b.notes = await notesFor(cred, src?.id ?? "");
        }),
      );
      out.set(env.branch, joined);
    }),
  );

  cache = { at: Date.now(), key, map: new Map(out), skipped };
  return { builds: out, skipped };
}

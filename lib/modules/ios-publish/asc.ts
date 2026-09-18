import "server-only";

import crypto from "node:crypto";

import type { AscCredentials } from "./config";
import { renderMessage } from "./message";

const BASE = "https://api.appstoreconnect.apple.com/v1";

/**
 * A short-lived ES256 JWT for App Store Connect.
 *
 * Signed with `node:crypto` rather than a JWT library: `dsaEncoding: 'ieee-p1363'`
 * emits the raw r‖s signature JOSE wants, so no dependency is needed. Apple caps
 * the lifetime at 20 minutes.
 */
function ascToken(cred: AscCredentials): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");

  const signingInput =
    `${b64({ alg: "ES256", kid: cred.keyId, typ: "JWT" })}.` +
    `${b64({ iss: cred.issuerId, iat: nowSec, exp: nowSec + 1200, aud: "appstoreconnect-v1" })}`;

  const signature = crypto
    .sign("sha256", Buffer.from(signingInput), {
      key: cred.p8Key,
      dsaEncoding: "ieee-p1363",
    })
    .toString("base64url");

  return `${signingInput}.${signature}`;
}

async function ascFetch<T>(
  cred: AscCredentials,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${ascToken(cred)}`,
      "Content-Type": "application/json",
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  const text = await res.text();
  const body = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = body?.errors?.[0];
    throw new Error(
      err?.detail || err?.title || `App Store Connect HTTP ${res.status}`,
    );
  }
  return body as T;
}

interface Listed {
  data?: Array<{
    id: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, { data?: { id?: string } | null }>;
  }>;
  /** Filled when the request asked for `include=…`. */
  included?: Array<{ id: string; attributes?: Record<string, unknown> }>;
}

/**
 * App ids by account and name.
 *
 * Resolving a name costs a download of the whole app catalogue, and the answer
 * does not change — but the branches board asks once per environment on every
 * build check, so half its App Store Connect budget was going on the same list
 * fetched again. An hour is short enough that renaming an app in App Store
 * Connect is noticed the same working session.
 */
const appIds = new Map<string, { at: number; id: string }>();
const APP_ID_TTL = 60 * 60 * 1000;

async function findAppId(
  cred: AscCredentials,
  appName: string,
): Promise<string> {
  const key = `${cred.issuerId}#${appName}`;
  const hit = appIds.get(key);
  if (hit && Date.now() - hit.at < APP_ID_TTL) return hit.id;

  const res = await ascFetch<Listed>(cred, "apps?limit=200");
  const app = res.data?.find((a) => a.attributes?.name === appName);
  if (!app) throw new Error(`Không thấy app "${appName}" trong tài khoản ASC`);
  appIds.set(key, { at: Date.now(), id: app.id });
  return app.id;
}

async function findGroupId(
  cred: AscCredentials,
  appId: string,
  groupName: string,
): Promise<string> {
  const res = await ascFetch<Listed>(
    cred,
    `apps/${appId}/betaGroups?limit=200`,
  );
  const group = res.data?.find((g) => g.attributes?.name === groupName);
  if (!group)
    throw new Error(`Không thấy nhóm external "${groupName}" của app này`);
  return group.id;
}

export interface BuildStatus {
  buildId: string;
  processingState: string;
  externalBuildState: string;
}

async function findBuild(
  cred: AscCredentials,
  appId: string,
  buildNumber: string,
): Promise<BuildStatus> {
  const res = await ascFetch<Listed>(
    cred,
    `builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(buildNumber)}&limit=1`,
  );
  const build = res.data?.[0];
  if (!build) throw new Error(`Không thấy build ${buildNumber} của app`);

  const detail = await ascFetch<Listed>(
    cred,
    `buildBetaDetails?filter[build]=${build.id}`,
  );
  return {
    buildId: build.id,
    processingState: String(build.attributes?.processingState ?? "UNKNOWN"),
    externalBuildState: String(
      detail.data?.[0]?.attributes?.externalBuildState ?? "UNKNOWN",
    ),
  };
}

async function addBuildToGroup(
  cred: AscCredentials,
  groupId: string,
  buildId: string,
) {
  await ascFetch(cred, `betaGroups/${groupId}/relationships/builds`, {
    method: "POST",
    body: { data: [{ type: "builds", id: buildId }] },
  });
}

async function submitForBetaReview(cred: AscCredentials, buildId: string) {
  await ascFetch(cred, "betaAppReviewSubmissions", {
    method: "POST",
    body: {
      data: {
        type: "betaAppReviewSubmissions",
        relationships: { build: { data: { type: "builds", id: buildId } } },
      },
    },
  });
}

async function setWhatToTest(
  cred: AscCredentials,
  buildId: string,
  whatsNew: string,
) {
  const locs = await ascFetch<Listed>(
    cred,
    `builds/${buildId}/betaBuildLocalizations`,
  );
  const locId = locs.data?.[0]?.id;
  if (!locId) return;
  await ascFetch(cred, `betaBuildLocalizations/${locId}`, {
    method: "PATCH",
    body: {
      data: {
        type: "betaBuildLocalizations",
        id: locId,
        attributes: { whatsNew },
      },
    },
  });
}

/** A build App Store Connect already holds, as the branches board reads them. */
export interface AscBuild {
  /** App Store Connect's own id, needed to reach the build's notes. */
  id: string;
  /** The build number — a GitHub runner timestamp, e.g. `20260903100223`. */
  version: string;
  /** When Apple received it, epoch seconds. */
  uploadedAt: number;
  processingState: string;
  /**
   * Apple's own word on whether testers can install it — `IN_BETA_TESTING` once
   * released, `READY_FOR_BETA_SUBMISSION` while it is merely uploaded.
   *
   * Worth reading because the board was inferring this from whether a release
   * note had been written, which is a guess standing on a guess. '' when Apple
   * says nothing.
   */
  externalState: string;
}

/**
 * Recent builds of an app, newest first.
 *
 * Read-only and deliberately thin: the branches board only needs to know that a
 * build exists and roughly when, so it can tell a merged branch from a shipped
 * one. Anything about beta review belongs to the publish flow above.
 */
export async function listBuilds(
  cred: AscCredentials,
  appName: string,
  limit = 30,
): Promise<AscBuild[]> {
  const appId = await findAppId(cred, appName);
  // `include` rather than a request per build: the beta detail rides along with
  // the list for nothing, where asking separately would be one more App Store
  // Connect call per build to learn a single word.
  const res = await ascFetch<Listed>(
    cred,
    `builds?filter[app]=${appId}&limit=${Math.min(limit, 200)}&sort=-version` +
      `&include=buildBetaDetail`,
  );
  const detail = new Map(
    (res.included ?? []).map((i) => [i.id, i.attributes ?? {}]),
  );
  return (res.data ?? [])
    .map((b) => ({
      id: String(b.id ?? ""),
      version: String(b.attributes?.version ?? ""),
      uploadedAt: Math.floor(
        new Date(String(b.attributes?.uploadedDate ?? 0)).getTime() / 1000,
      ),
      processingState: String(b.attributes?.processingState ?? "UNKNOWN"),
      externalState: String(
        detail.get(String(b.relationships?.buildBetaDetail?.data?.id ?? ""))
          ?.externalBuildState ?? "",
      ),
    }))
    .filter((b) => b.version);
}

/**
 * The "What to Test" note attached to a build.
 *
 * This team's publish script writes the tickets a build carries into it —
 * `- CTalk: VT-17252, VT-523, VT-525` — which is the only place App Store
 * Connect says anything about *content*. Empty when the build has been uploaded
 * but not yet published to testers, since the note is written at publish time.
 */
export async function buildNotes(
  cred: AscCredentials,
  buildId: string,
): Promise<string> {
  if (!buildId) return "";
  const res = await ascFetch<Listed>(
    cred,
    `builds/${buildId}/betaBuildLocalizations`,
  );
  for (const d of res.data ?? []) {
    const t = String(d.attributes?.whatsNew ?? "").trim();
    if (t) return t;
  }
  return "";
}

export interface ResolvedStatus extends BuildStatus {
  appId: string;
  groupId: string;
}

/** Looks up app, group and build without changing anything. */
export async function resolveStatus(
  cred: AscCredentials,
  input: { appName: string; groupName: string; buildNumber: string },
): Promise<ResolvedStatus> {
  const appId = await findAppId(cred, input.appName);
  const groupId = await findGroupId(cred, appId, input.groupName);
  const build = await findBuild(cred, appId, input.buildNumber);
  return { appId, groupId, ...build };
}

export interface NotifyConfig {
  webhook: string;
  roomIds: string;
  /** Message template with {app} {version} {build} {content} placeholders. */
  template: string;
}

/**
 * Announces the new build to a chat bot. Same shape as the original notifyBot —
 * POST `{ text, roomIds }` to the webhook. Best-effort: a failed notify never
 * fails the publish, so a bad webhook can't block a build that already shipped.
 */
async function notifyBot(notify: NotifyConfig, text: string) {
  try {
    await fetch(notify.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, roomIds: notify.roomIds.trim() }),
      cache: "no-store",
    });
  } catch {
    // swallowed on purpose — see doc comment
  }
}

export interface SubmitOutcome {
  done: boolean;
  /** True only when this call actually pushed the build (not already testing). */
  submitted: boolean;
  message: string;
  status: BuildStatus;
}

/**
 * Submits a ready build to external testing. Mirrors the original service:
 * add to the group, create the beta-review submission, attach the "What to
 * Test" notes, then notify the bot. A build still processing on Apple's side is
 * reported back rather than polled — the user re-runs once it is VALID.
 */
export async function submitToExternalTesting(
  cred: AscCredentials,
  input: {
    appName: string;
    version: string;
    groupName: string;
    buildNumber: string;
    whatsNew: string;
  },
  notify?: NotifyConfig,
): Promise<SubmitOutcome> {
  const st = await resolveStatus(cred, input);
  const status: BuildStatus = {
    buildId: st.buildId,
    processingState: st.processingState,
    externalBuildState: st.externalBuildState,
  };

  if (st.processingState === "PROCESSING") {
    return {
      done: false,
      submitted: false,
      message: "Apple đang xử lý build — thử lại sau ít phút.",
      status,
    };
  }
  if (st.externalBuildState === "IN_BETA_TESTING") {
    return {
      done: true,
      submitted: false,
      message: "Build đã đang external testing rồi.",
      status,
    };
  }
  if (
    st.externalBuildState === "READY_FOR_BETA_SUBMISSION" &&
    st.processingState === "VALID"
  ) {
    await addBuildToGroup(cred, st.groupId, st.buildId);
    await submitForBetaReview(cred, st.buildId);
    if (input.whatsNew.trim())
      await setWhatToTest(cred, st.buildId, input.whatsNew.trim());
    if (notify?.webhook.trim())
      await notifyBot(notify, renderMessage(notify.template, input));
    return {
      done: true,
      submitted: true,
      message: "Đã submit build lên external testing.",
      status,
    };
  }

  return {
    done: false,
    submitted: false,
    message: `Chưa submit được — trạng thái: ${st.externalBuildState} / ${st.processingState}.`,
    status,
  };
}

import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";

import { DEFAULT_BRANCH_SUFFIXES } from "./model";

/**
 * Settings for the SDK release module, in the shared `settings` table under
 * `mod:sdk-release:` — the same arrangement every other module uses, so the
 * module owns its keys without touching the core `SETTING_KEYS` enum.
 *
 * Nothing here is a secret, and that is the most reassuring fact about this
 * module: the GitHub token the release tool uses lives in `~/.netrc`, outside
 * the app entirely. The app never reads its value, only whether the entry
 * exists. There is therefore nothing to strip on the way to the browser —
 * {@link toConfigView} exists for shape consistency with the other modules and
 * to have somewhere to say this.
 */
const PREFIX = "mod:sdk-release:";
const K = {
  /** Clone of `viptalk-matrix-rust-sdk-ruma` — the Rust source. */
  sdkPath: `${PREFIX}sdk_path`,
  /** Clone of `viptalk-matrix-rust-components-swift` — where the release lands. */
  packagePath: `${PREFIX}package_path`,
  /**
   * `{branch: suffix}`, seeded once with the guide's own table and editable in
   * the Cấu hình tab. An exact hit beats every derivation rule.
   *
   * This is what makes the module usable by a team other than the one it was
   * written for: the team *prefix* needs no configuration — it is the branch's
   * first segment — but the exceptions do, and those are per-team.
   */
  suffixes: `${PREFIX}suffixes`,
  /**
   * Stand-in for `swift run release`, for exercising the runner.
   *
   * Empty in normal use. A real dry run costs forty minutes, so without this
   * the durable half of this module — detached spawn, log tailing, reaping a
   * process whose parent died — would only ever be tested by accident.
   */
  fakeCommand: `${PREFIX}fake_command`,
} as const;

function getRaw(key: string): string | undefined {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value;
}

function setRaw(key: string, value: string) {
  const stamp = Math.floor(Date.now() / 1000);
  db.insert(settings)
    .values({ key, value, updatedAt: stamp })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: stamp } })
    .run();
}

export interface SdkConfig {
  sdkPath: string;
  packagePath: string;
  suffixes: Record<string, string>;
  fakeCommand: string;
}

/** Defensive: these rows are hand-editable, so a bad one must not throw. */
function readMap(raw: string | undefined): Record<string, string> | null {
  if (raw === undefined) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) out[String(k).trim()] = String(val).trim();
    return out;
  } catch {
    return {};
  }
}

export function getSdkConfig(): SdkConfig {
  // Seeded on `raw === undefined` rather than on falsy, so a user who
  // deliberately empties the map keeps it empty.
  let suffixes = readMap(getRaw(K.suffixes));
  if (suffixes === null) {
    suffixes = { ...DEFAULT_BRANCH_SUFFIXES };
    setRaw(K.suffixes, JSON.stringify(suffixes));
  }

  return {
    sdkPath: (getRaw(K.sdkPath) ?? "").trim(),
    packagePath: (getRaw(K.packagePath) ?? "").trim(),
    suffixes,
    // Empty in normal use; see the key's note. There is no dry-run mode any
    // more, so this is the only way to exercise the runner without a release.
    fakeCommand: (getRaw(K.fakeCommand) ?? "").trim(),
  };
}

export function setSdkConfig(input: {
  sdkPath: string;
  packagePath: string;
  suffixes: Record<string, string>;
}) {
  setRaw(K.sdkPath, input.sdkPath.trim());
  setRaw(K.packagePath, input.packagePath.trim());
  const clean: Record<string, string> = {};
  for (const [branch, suffix] of Object.entries(input.suffixes)) {
    const b = branch.trim();
    // An empty *suffix* is meaningful — that is how `master` is spelled — so
    // only a blank branch name is dropped.
    if (b) clean[b] = suffix.trim();
  }
  setRaw(K.suffixes, JSON.stringify(clean));
}


/** True once both clones are configured; without them nothing here can run. */
export function isSdkConfigured(): boolean {
  const cfg = getSdkConfig();
  return Boolean(cfg.sdkPath && cfg.packagePath);
}

/**
 * The config as the browser may see it.
 *
 * Identical to the stored config, because none of it is secret — see the note
 * at the top. Kept as a named builder anyway so this module reads like the
 * others, and so there is one obvious place to strip something the day a secret
 * does arrive.
 */
export type SdkConfigView = Omit<SdkConfig, "fakeCommand"> & {
  /** Whether a stand-in command is set — the value itself is nobody's business. */
  faking: boolean;
};

export function toConfigView(cfg: SdkConfig): SdkConfigView {
  const { fakeCommand, ...rest } = cfg;
  return { ...rest, faking: Boolean(fakeCommand) };
}

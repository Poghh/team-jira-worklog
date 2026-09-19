import { connection } from "next/server";

import { ModuleGate } from "@/lib/modules/gate";
import { getSdkConfig, toConfigView } from "@/lib/modules/sdk-release/config";
import { reapRuns } from "@/lib/modules/sdk-release/runner";
import { listRuns } from "@/lib/modules/sdk-release/store";

import { SdkRelease } from "./console";

export default async function SdkReleasePage() {
  // Required before the gate: the enabled check is a synchronous SQLite read
  // and must not resolve during prerender.
  await connection();

  /**
   * Bring any unfinished run up to date before drawing it.
   *
   * The build outlives the request that started it, so a row saying "running"
   * is a claim about a process this server may never have met — it might be a
   * different dev server entirely. Reaping here means the page never shows a
   * run as live when its process died while nobody was looking.
   */
  await reapRuns();

  const cfg = getSdkConfig();

  return (
    <ModuleGate id="sdk-release">
      {/* No `.wide-page` here. That rule is the kanban's, for five columns
          that cannot be narrowed; this screen is a rail and a log and sits in
          the same 1340px as every other module. */}
      <SdkRelease view={toConfigView(cfg)} runs={listRuns(10)} />
    </ModuleGate>
  );
}

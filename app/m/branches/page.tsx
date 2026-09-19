import { connection } from "next/server";

import { getIssueStatuses } from "@/lib/jira/issues";
import { SETTING_KEYS, getSetting } from "@/lib/settings";
import { ModuleGate } from "@/lib/modules/gate";
import { getGitHubConfig, toConfigView } from "@/lib/modules/branches/config";
import {
  cleanupStep,
  hostOf,
  jiraLookups,
  ticketsDone,
} from "@/lib/modules/branches/model";
import {
  listTaskNotes,
  settleFinishedCards,
} from "@/lib/modules/branches/store";

import { BranchBoard } from "./board";

export default async function BranchesPage() {
  await connection();

  let notes = listTaskNotes();
  // One read of the settings row: `getGitHubConfig` already parses the
  // pipeline, and asking for it separately read the same row twice per render.
  const gh = getGitHubConfig();
  const stages = gh.stages;
  const baseUrl =
    getSetting(SETTING_KEYS.jiraBaseUrl)?.replace(/\/+$/, "") ?? "";

  // Live status for the cards that name a Jira issue. Wrapped because the whole
  // board is useful without Jira — the notes and branches are local — and a
  // credential problem must cost the drift badges, not the page.
  let statuses: Record<
    string,
    {
      statusName: string;
      issueTypeName: string;
      summary: string;
      /**
       * The ticket this status actually came from.
       *
       * Usually the card's own key, and not when a link is pinned — a card
       * keyed `VT-451` whose link points at `VT-458` is *about* VT-458, and
       * every control the board offers for it has to act on VT-458. Carried
       * rather than recomputed because the mapping lives here, where the links
       * were resolved.
       */
      key: string;
    }
  > = {};
  // Whether a missing status means "Jira could not find this ticket" rather
  // than "Jira was never asked". Without it the board cannot tell a card with
  // no ticket apart from one whose ticket lives somewhere this account cannot
  // see, and it stays silent about both.
  const jiraLive = Boolean(getSetting(SETTING_KEYS.jiraApiToken));
  /** '' when Jira answered — the reason when the call itself failed. */
  let jiraError = "";

  /**
   * Where each ticket is looked up, honouring the links the user pinned.
   *
   * A pinned link is the authority on which ticket a card is about, and this
   * board carries links to a second Jira site entirely — asking the configured
   * one for those keys returns "does not exist", which is true and useless.
   */
  const lookups = jiraLookups(
    [...new Set(notes.flatMap((n) => n.issueKeys))],
    Object.fromEntries(notes.flatMap((n) => Object.entries(n.jiraUrls))),
    baseUrl,
  );
  const home = hostOf(baseUrl);
  /** Tickets whose pinned link points at a Jira these credentials cannot reach. */
  const offSite = Object.fromEntries(
    Object.entries(lookups)
      .filter(([, ref]) => ref.host && ref.host !== home)
      .map(([key, ref]) => [key, ref.host]),
  );

  if (jiraLive) {
    // Every ticket on every card, not just the primary keys. A card covering
    // two tickets could otherwise only ever report on the first of them, so
    // "which of these is still on the feature branch" had no answer to give.
    const here = Object.entries(lookups).filter(
      ([, ref]) => !ref.host || ref.host === home,
    );
    /**
     * A failed call and an empty answer are different things.
     *
     * They used to collapse into the same `{}`: a VPN dropping out made every
     * card read "Jira không thấy" — the board asserting, about somebody else's
     * Jira, that the ticket does not exist. What it actually knew was that it
     * could not ask. The message is carried through so the board can say which
     * of the two happened, and so the reader knows whether to fix their
     * network or their ticket key.
     */
    const found = await getIssueStatuses(here.map(([, r]) => r.key)).catch(
      (
        e,
      ): Record<
        string,
        { statusName: string; issueTypeName: string; summary: string }
      > => {
        jiraError =
          e instanceof Error ? e.message : "Không gọi được Jira";
        return {};
      },
    );
    // Back onto the card's own key: the board draws badges per card key, and
    // the key Jira was asked for may not be the one written on the card.
    statuses = Object.fromEntries(
      here.flatMap(([key, ref]) =>
        found[ref.key] ? [[key, { ...found[ref.key], key: ref.key }]] : [],
      ),
    );
  }

  /**
   * Cards Jira has closed, moved to the end of the pipeline.
   *
   * Here rather than in the scan because the scan reads GitHub, and "is this
   * ticket closed" is not a question GitHub can answer — the board would only
   * finish a card on the days somebody happened to run a scan. This runs on
   * every load, off the statuses fetched two lines up, so closing a ticket in
   * Jira and refreshing the board is enough.
   *
   * Safe when Jira is unreachable: a failed call leaves `statuses` empty, and
   * an empty answer reads as "not done" for every card, so nothing moves. The
   * write is skipped entirely rather than looped over when there is nothing to
   * do, which is the ordinary case.
   */
  const end = cleanupStep(stages)?.name ?? "";
  const finished = notes
    .filter(
      (n) =>
        // Cards already there are skipped rather than re-derived: on a board
        // whose work is mostly finished that is one row read per card per
        // render, every render, to conclude nothing.
        n.stage !== end &&
        ticketsDone(n.issueKeys.map((k) => statuses[k]?.statusName ?? null)),
    )
    .map((n) => n.id);
  if (finished.length && settleFinishedCards(finished)) notes = listTaskNotes();

  // Everything about the GitHub link *except* the token — the browser gets to
  // know where the token comes from, never what it is.
  const ghView = toConfigView(gh);

  return (
    <ModuleGate id="branches">
      {/* Five pipeline columns do not fit in 1340px; see `.wide-page`. */}
      <div className="wide-page">
        <BranchBoard
          initial={notes}
          stages={stages}
          statuses={statuses}
          baseUrl={baseUrl}
          jiraLive={jiraLive}
          jiraError={jiraError}
          offSite={offSite}
          ghView={ghView}
        />
      </div>
    </ModuleGate>
  );
}

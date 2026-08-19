import type { SourceAdapter } from "./types";
import { barrattLondonAdapter } from "./barrattLondon";
import { taylorWimpeyLondonAdapter } from "./taylorWimpeyLondon";
import { ballymoreAdapter } from "./ballymore";
import { lqHomesAdapter } from "./lqHomes";
import { bellwayLondonAdapter } from "./bellwayLondon";
import { berkeleyAdapter } from "./berkeley";
import { fairviewNewHomesAdapter } from "./fairviewNewHomes";
import { peabodyNewHomesAdapter } from "./peabodyNewHomes";
import { redrowAdapter } from "./redrow";
import { oneNewHomesAdapter } from "./oneNewHomes";
import { benhamsAdapter } from "./benhams";
import { createAutoAdapter } from "./autoAdapter";
import { ALLOWED_DEVELOPERS, ALLOWED_DEVELOPER_NAMES } from "../developers";

// Real, hand-built adapters, keyed by developer id — add entries here as
// more get built (they take priority over the generic auto-adapter below).
const REAL_ADAPTERS: Record<string, SourceAdapter> = {
  [barrattLondonAdapter.id]: barrattLondonAdapter,
  [taylorWimpeyLondonAdapter.id]: taylorWimpeyLondonAdapter,
  [ballymoreAdapter.id]: ballymoreAdapter,
  [lqHomesAdapter.id]: lqHomesAdapter,
  [bellwayLondonAdapter.id]: bellwayLondonAdapter,
  [berkeleyAdapter.id]: berkeleyAdapter,
  [fairviewNewHomesAdapter.id]: fairviewNewHomesAdapter,
  [peabodyNewHomesAdapter.id]: peabodyNewHomesAdapter,
  [redrowAdapter.id]: redrowAdapter,
  [oneNewHomesAdapter.id]: oneNewHomesAdapter,
  [benhamsAdapter.id]: benhamsAdapter,
};

// One adapter per developer in london-developers.json — the file is
// reloaded and the registry regenerated from it every time this module
// loads, so it's always the file (not this code) that decides which sources
// may exist. See lib/developers.ts for how _meta.rules are enforced.
//
// Everything without a hand-built adapter gets the generic auto-adapter
// (lib/adapters/autoAdapter.ts) instead of a stub — it always genuinely
// attempts real extraction and never fabricates, so there's no case where
// falling back to it is less honest than a stub that never tries at all.
export const adapters: SourceAdapter[] = ALLOWED_DEVELOPERS.map((developer) => {
  const real = REAL_ADAPTERS[developer.id];
  if (!real) {
    return createAutoAdapter(developer);
  }
  if (real.name !== developer.name) {
    throw new Error(
      `Adapter "${developer.id}" is named "${real.name}" but london-developers.json ` +
        `says "${developer.name}" — source labels must match exactly.`
    );
  }
  return real;
});

// Fail fast if a real adapter's id is no longer present in the file (e.g.
// after a rename) — better than silently registering an unapproved source.
for (const id of Object.keys(REAL_ADAPTERS)) {
  if (!ALLOWED_DEVELOPER_NAMES.has(id)) {
    throw new Error(
      `Adapter "${id}" has real scraping logic but is not listed in ` +
        `london-developers.json — refusing to register an unapproved source.`
    );
  }
}

import type { TrackerRow } from "./trackerTypes";

/** Not-rejected rows before rejected rows, otherwise stable (JS's
 * Array.prototype.sort has been a stable sort since ES2019, so equal-key
 * rows keep their existing relative order) — the exact "ticking Rejected
 * moves a row to the bottom, unticking restores its original position"
 * behaviour, driven entirely by the array order already being creation
 * order (see lib/trackerStore.ts's listTrackerRows ordering, and the fact
 * that a newly-added row is appended locally). Shared by the on-screen
 * table and the Excel export so what's on screen and what's downloaded can
 * never show a different row order. */
export function sortTrackerRows(rows: TrackerRow[]): TrackerRow[] {
  return [...rows].sort((a, b) => Number(a.rejected) - Number(b.rejected));
}

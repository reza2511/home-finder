/** One row of the Property Tracker (supabase/migrations/0014_property_tracker.sql).
 * Every text field is "" rather than null when empty (matches the column
 * defaults) so the UI never has to special-case null vs empty string in an
 * editable text input; `viewDate` and `extractionNote` are the two
 * genuinely-nullable fields. */
export interface TrackerRow {
  id: string;
  url: string;
  /** The property/development's own name — pre-filled by the extraction
   * step when the pasted page states one, left blank otherwise for the
   * operator to type themselves (unlike the other AI-extracted fields,
   * this one is also meant to be hand-typed when extraction can't find
   * it, not just a fallback for a failed read). */
  name: string;
  price: string;
  bedrooms: string;
  floor: string;
  developer: string;
  address: string;
  /** ISO date (YYYY-MM-DD), picked by the operator — never scraped. */
  viewDate: string | null;
  area: string;
  postcode: string;
  comment: string;
  /** A video link (YouTube, Google Drive, or any URL) the operator pastes
   * in themselves — never scraped, same as comment/viewDate. */
  video: string;
  rejected: boolean;
  viewed: boolean;
  contactedAgent: boolean;
  /** Tracked and saved like every other tick box, but carries no row colour
   * of its own — see components/PropertyTrackerTable.tsx's row-colour
   * priority (rejected > interested > neither). */
  awaitingAgentCall: boolean;
  /** Highlights the whole row light orange when true — UNLESS `rejected` is
   * also true, in which case rejected's red always wins (see
   * components/PropertyTrackerTable.tsx). */
  interested: boolean;
  /** Set when the page couldn't be read at add-time (blocked/error) — shown
   * as a "couldn't read this page" note. Null once every AI field came back
   * fine, or after the operator has filled the row in by hand. */
  extractionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Fields PATCH /api/tracker/[id] accepts — every column the operator can
 * hand-edit. Deliberately excludes id/createdAt/updatedAt/extractionNote
 * (that last one is only ever set by the extraction step itself, at
 * creation time — editing it away would misrepresent what the AI actually
 * found, or failed to find). */
export type TrackerRowPatch = Partial<
  Pick<
    TrackerRow,
    | "url"
    | "name"
    | "price"
    | "bedrooms"
    | "floor"
    | "developer"
    | "address"
    | "viewDate"
    | "area"
    | "postcode"
    | "comment"
    | "video"
    | "rejected"
    | "viewed"
    | "contactedAgent"
    | "awaitingAgentCall"
    | "interested"
  >
>;

export interface TrackerBackupSummary {
  date: string;
  capturedAt: string;
  rowCount: number;
}

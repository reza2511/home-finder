"use client";

import { sortTrackerRows } from "@/lib/trackerSort";
import type { TrackerRow, TrackerRowPatch } from "@/lib/trackerTypes";

interface Props {
  rows: TrackerRow[];
  /** Applies an edit to one row: updates local state immediately and
   * schedules (or, for a tick box, sends right away) the auto-save PATCH —
   * see app/property-tracker/page.tsx's handleEdit. */
  onEdit: (id: string, patch: TrackerRowPatch) => void;
  onDelete: (id: string) => void;
  savingIds: Set<string>;
  /** "Don't show these again" preference — when true, the read-error
   * indicator icon is suppressed entirely, for every row. */
  hideExtractionNotes: boolean;
}

const TEXT_FIELDS: { key: keyof TrackerRowPatch; label: string; placeholder?: string }[] = [
  { key: "price", label: "Price" },
  { key: "bedrooms", label: "Bedrooms" },
  { key: "floor", label: "Floor" },
  { key: "developer", label: "Developer" },
  { key: "address", label: "Address" },
  { key: "area", label: "Area" },
  { key: "postcode", label: "Postcode" },
];

/** Row colour priority: Rejected (red) always wins over Interested (light
 * orange) when a row is both — decided once, here, in plain JS rather than
 * leaning on CSS cascade/specificity between two classes, so there's exactly
 * one place that ever has to agree on the ordering. */
function rowClassName(row: TrackerRow): string {
  if (row.rejected) return "tracker-table__row--rejected";
  if (row.interested) return "tracker-table__row--interested";
  return "";
}

export default function PropertyTrackerTable({ rows, onEdit, onDelete, savingIds, hideExtractionNotes }: Props) {
  const sorted = sortTrackerRows(rows);

  if (sorted.length === 0) {
    return <p className="tracker-empty">No properties yet — paste a URL above and click Add.</p>;
  }

  return (
    <div className="tracker-table-wrap">
      <table className="tracker-table">
        <thead>
          <tr>
            <th>Link</th>
            <th>Name</th>
            {TEXT_FIELDS.map((f) => (
              <th key={f.key}>{f.label}</th>
            ))}
            <th>View date</th>
            <th>Comment</th>
            <th>Video</th>
            <th>Rejected</th>
            <th>Viewed</th>
            <th>Contacted agent</th>
            <th>Awaiting agent call</th>
            <th>Interested</th>
            <th aria-label="Remove"></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.id} className={rowClassName(row)}>
              <td className="tracker-table__link-cell">
                <div className="tracker-table__link-row">
                  <a
                    href={row.url || undefined}
                    target="_blank"
                    rel="noreferrer"
                    className={`tracker-table__open-link${row.url ? "" : " tracker-table__open-link--disabled"}`}
                    aria-label="Open listing"
                    title="Open listing"
                    onClick={(e) => {
                      if (!row.url) e.preventDefault();
                    }}
                  >
                    ↗
                  </a>
                  {!hideExtractionNotes && row.extractionNote && (
                    <span
                      className={
                        row.extractionNote.startsWith("Couldn't read")
                          ? "tracker-table__note-icon tracker-table__note-icon--error"
                          : "tracker-table__note-icon tracker-table__note-icon--info"
                      }
                      title={row.extractionNote}
                      aria-label={row.extractionNote}
                    >
                      {row.extractionNote.startsWith("Couldn't read") ? "⚠" : "ⓘ"}
                    </span>
                  )}
                </div>
              </td>

              <td>
                <input
                  type="text"
                  className="tracker-table__input"
                  value={row.name}
                  placeholder="Property name"
                  onChange={(e) => onEdit(row.id, { name: e.target.value })}
                />
              </td>

              {TEXT_FIELDS.map((f) => (
                <td key={f.key}>
                  <input
                    type="text"
                    className="tracker-table__input"
                    value={row[f.key] as string}
                    onChange={(e) => onEdit(row.id, { [f.key]: e.target.value } as TrackerRowPatch)}
                  />
                </td>
              ))}

              <td>
                <input
                  type="date"
                  className="tracker-table__input"
                  value={row.viewDate ?? ""}
                  onChange={(e) => onEdit(row.id, { viewDate: e.target.value || null })}
                />
              </td>

              <td>
                <textarea
                  className="tracker-table__textarea"
                  rows={2}
                  value={row.comment}
                  onChange={(e) => onEdit(row.id, { comment: e.target.value })}
                />
              </td>

              <td className="tracker-table__video-cell">
                <div className="tracker-table__video-row">
                  <input
                    type="text"
                    className="tracker-table__input tracker-table__input--url"
                    value={row.video}
                    placeholder="Paste video link"
                    onChange={(e) => onEdit(row.id, { video: e.target.value })}
                  />
                  {row.video ? (
                    <a href={row.video} target="_blank" rel="noreferrer" className="tracker-table__video-link">
                      ▶ View video
                    </a>
                  ) : (
                    <span className="tracker-table__video-placeholder">Add video</span>
                  )}
                </div>
              </td>

              <td className="tracker-table__check-cell">
                <input
                  type="checkbox"
                  checked={row.rejected}
                  onChange={(e) => onEdit(row.id, { rejected: e.target.checked })}
                  aria-label="Rejected"
                />
              </td>
              <td className="tracker-table__check-cell">
                <input
                  type="checkbox"
                  checked={row.viewed}
                  onChange={(e) => onEdit(row.id, { viewed: e.target.checked })}
                  aria-label="Viewed"
                />
              </td>
              <td className="tracker-table__check-cell">
                <input
                  type="checkbox"
                  checked={row.contactedAgent}
                  onChange={(e) => onEdit(row.id, { contactedAgent: e.target.checked })}
                  aria-label="Contacted agent"
                />
              </td>
              <td className="tracker-table__check-cell">
                <input
                  type="checkbox"
                  checked={row.awaitingAgentCall}
                  onChange={(e) => onEdit(row.id, { awaitingAgentCall: e.target.checked })}
                  aria-label="Awaiting agent call"
                />
              </td>
              <td className="tracker-table__check-cell">
                <input
                  type="checkbox"
                  checked={row.interested}
                  onChange={(e) => onEdit(row.id, { interested: e.target.checked })}
                  aria-label="Interested"
                />
              </td>

              <td className="tracker-table__actions-cell">
                <div className="tracker-table__actions-inner">
                  {savingIds.has(row.id) && (
                    <span className="tracker-table__saving" title="Saving…" aria-label="Saving">
                      ●
                    </span>
                  )}
                  <button
                    type="button"
                    className="tracker-table__remove"
                    onClick={() => onDelete(row.id)}
                    aria-label="Remove row"
                    title="Remove this row"
                  >
                    ×
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

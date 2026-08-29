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

export default function PropertyTrackerTable({ rows, onEdit, onDelete, savingIds }: Props) {
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
            <th aria-label="Remove"></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.id} className={row.rejected ? "tracker-table__row--rejected" : ""}>
              <td className="tracker-table__link-cell">
                <div className="tracker-table__link-row">
                  <input
                    type="text"
                    className="tracker-table__input tracker-table__input--url"
                    value={row.url}
                    placeholder="Property URL"
                    onChange={(e) => onEdit(row.id, { url: e.target.value })}
                  />
                  <a
                    href={row.url || undefined}
                    target="_blank"
                    rel="noreferrer"
                    className={`tracker-table__open-link${row.url ? "" : " tracker-table__open-link--disabled"}`}
                    aria-label="Open listing"
                    onClick={(e) => {
                      if (!row.url) e.preventDefault();
                    }}
                  >
                    ↗
                  </a>
                </div>
                {row.extractionNote && (
                  <div
                    className={
                      row.extractionNote.startsWith("Couldn't read")
                        ? "tracker-table__note tracker-table__note--error"
                        : "tracker-table__note tracker-table__note--info"
                    }
                    title={row.extractionNote}
                  >
                    {row.extractionNote.startsWith("Couldn't read")
                      ? "⚠ Couldn't read this page — fill in manually"
                      : "ℹ AI extraction unavailable — some fields may be missing"}
                  </div>
                )}
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

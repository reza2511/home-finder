import type { SourceBreakdownEntry } from "@/lib/sourceBreakdown";

/** Every source's current count, not just the pie/stacked-bar's top 7 —
 * this is the "relief" the dataviz palette check requires wherever a
 * slice/segment color sits below 3:1 contrast (aqua, yellow, magenta):
 * the exact number for every source is always available here, never
 * gated behind reading a color. */
export default function StatsSourceTable({ bySource, total }: { bySource: SourceBreakdownEntry[]; total: number }) {
  if (bySource.length === 0) {
    return <p className="stats-empty">No active listings yet.</p>;
  }

  return (
    <div className="status-table-wrap">
      <table className="status-table">
        <thead>
          <tr>
            <th>Source</th>
            <th className="stats-table__num">Listings</th>
            <th className="stats-table__num">Share</th>
          </tr>
        </thead>
        <tbody>
          {bySource.map((s) => (
            <tr key={s.sourceId}>
              <td className="status-table__source">{s.sourceName}</td>
              <td className="stats-table__num">{s.listingCount.toLocaleString("en-GB")}</td>
              <td className="stats-table__num status-table__muted">
                {total > 0 ? `${((s.listingCount / total) * 100).toFixed(1)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

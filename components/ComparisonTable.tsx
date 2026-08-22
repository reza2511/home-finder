import type { CompareResult } from "@/lib/compareExtract";
import { buildComparisonTable } from "@/lib/compareTableModel";

export default function ComparisonTable({ results }: { results: CompareResult[] }) {
  const { columns, rows } = buildComparisonTable(results);

  return (
    <div className="compare-table-wrap">
      <table className="compare-table">
        <thead>
          <tr>
            <th>Attribute</th>
            {columns.map((c, i) => (
              <th key={i} className={c.ok ? "" : "compare-table__col--failed"}>
                <div className="compare-table__header-name">{c.header}</div>
                <a href={c.url} target="_blank" rel="noreferrer" className="compare-table__header-url">
                  {c.url}
                </a>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              {row.values.map((value, colIndex) => {
                const col = columns[colIndex];
                // The Status row is the one place a failed column actually
                // says "Could not read" — every attribute row below it just
                // shows "—" for that column, since the status row already
                // makes the failure unambiguous without repeating it nine
                // more times.
                const display =
                  rowIndex === 1 && !col.ok ? "Could not read" : value;
                return (
                  <td key={colIndex} className={col.ok ? "" : "compare-table__col--failed"} title={rowIndex === 1 && !col.ok ? col.statusLabel : undefined}>
                    {display}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

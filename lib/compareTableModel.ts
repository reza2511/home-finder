import type { CompareResult, ComparePropertyFields } from "./compareExtract";

export const ATTRIBUTE_ROWS: { key: keyof ComparePropertyFields; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "location", label: "Location" },
  { key: "postcode", label: "Postcode" },
  { key: "bedrooms", label: "Bedrooms" },
  { key: "bathrooms", label: "Bathrooms" },
  { key: "floorArea", label: "Floor area" },
  { key: "parking", label: "Parking" },
  { key: "price", label: "Price" },
  { key: "lastSoldPrice", label: "Last sold price" },
];

export interface ComparisonColumn {
  url: string;
  /** The extracted name, or a fallback (hostname) when there's no name or
   * the URL couldn't be read at all — always a real, present piece of
   * information, never invented. */
  header: string;
  ok: boolean;
  statusLabel: string;
}

export interface ComparisonRow {
  label: string;
  /** One value per column, in the same order as `columns` — "—" for a
   * field the page genuinely didn't state, never a guess. A column that
   * couldn't be read at all gets "—" in every attribute row too; its
   * failure is what the column's own `statusLabel` already says. */
  values: string[];
}

export interface ComparisonTable {
  columns: ComparisonColumn[];
  rows: ComparisonRow[];
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Builds the exact same row/column model both the on-screen table
 * (components/ComparisonTable.tsx) and the "Export to Excel" button read
 * from — a single source of truth so what's on screen and what's in the
 * spreadsheet can never drift apart. */
export function buildComparisonTable(results: CompareResult[]): ComparisonTable {
  const columns: ComparisonColumn[] = results.map((r) => {
    if (r.status === "ok") {
      return {
        url: r.url,
        header: r.fields.name ?? hostnameOf(r.url),
        ok: true,
        statusLabel: "Read successfully",
      };
    }
    const reason = r.status === "blocked" ? "Blocked" : "Error";
    return {
      url: r.url,
      header: hostnameOf(r.url),
      ok: false,
      statusLabel: `Could not read — ${reason}: ${r.message}`,
    };
  });

  const urlRow: ComparisonRow = { label: "URL", values: results.map((r) => r.url) };
  const statusRow: ComparisonRow = {
    label: "Status",
    values: columns.map((c) => (c.ok ? "OK" : "Could not read")),
  };
  const attributeRows: ComparisonRow[] = ATTRIBUTE_ROWS.map(({ key, label }) => ({
    label,
    values: results.map((r) => (r.status === "ok" ? (r.fields[key] ?? "—") : "—")),
  }));

  return { columns, rows: [urlRow, statusRow, ...attributeRows] };
}

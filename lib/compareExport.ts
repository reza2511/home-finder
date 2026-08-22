import * as XLSX from "xlsx";
import type { CompareResult } from "./compareExtract";
import { buildComparisonTable } from "./compareTableModel";

/** Builds a real .xlsx workbook from the comparison results (same row/
 * column model the on-screen table renders — see compareTableModel.ts) and
 * triggers a browser download. Runs entirely client-side: the data is
 * already in the page, so no server round-trip is needed just to format
 * it as a spreadsheet. */
export function exportComparisonToExcel(results: CompareResult[]): void {
  const { columns, rows } = buildComparisonTable(results);

  const header = ["Attribute", ...columns.map((c) => c.header)];
  const aoa: (string | number)[][] = [header, ...rows.map((row) => [row.label, ...row.values])];

  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  // Widen columns a little past their content's natural width so URLs and
  // longer field values (floor area, parking notes) aren't truncated on
  // open.
  worksheet["!cols"] = header.map((_, i) => ({
    wch: i === 0 ? 16 : Math.min(40, Math.max(14, ...aoa.map((r) => String(r[i] ?? "").length))),
  }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Comparison");

  const filename = `property-comparison-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.xlsx`;
  XLSX.writeFile(workbook, filename);
}

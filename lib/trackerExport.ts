import * as XLSX from "xlsx";
import type { TrackerRow } from "./trackerTypes";

const HEADER = [
  "Link",
  "Price",
  "Bedrooms",
  "Floor",
  "Developer",
  "Address",
  "View date",
  "Area",
  "Postcode",
  "Comment",
  "Rejected",
  "Viewed",
  "Contacted agent",
  "Note",
];

/** Builds a real .xlsx workbook from the current tracker rows — same
 * columns the on-screen table shows, in the same order — and triggers a
 * browser download. Runs entirely client-side: the rows are already loaded
 * in the page, so no server round-trip is needed just to format them as a
 * spreadsheet (mirrors lib/compareExport.ts). */
export function exportTrackerToExcel(rows: TrackerRow[]): void {
  const aoa: (string | number)[][] = [
    HEADER,
    ...rows.map((r) => [
      r.url,
      r.price,
      r.bedrooms,
      r.floor,
      r.developer,
      r.address,
      r.viewDate ?? "",
      r.area,
      r.postcode,
      r.comment,
      r.rejected ? "Yes" : "No",
      r.viewed ? "Yes" : "No",
      r.contactedAgent ? "Yes" : "No",
      r.extractionNote ?? "",
    ]),
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  worksheet["!cols"] = HEADER.map((_, i) => ({
    wch: Math.min(45, Math.max(12, ...aoa.map((row) => String(row[i] ?? "").length))),
  }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Property Tracker");

  const filename = `property-tracker-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.xlsx`;
  XLSX.writeFile(workbook, filename);
}

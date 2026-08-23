/**
 * Categorical chart palette — the validated default from the dataviz
 * skill's reference palette (light mode only; this app has no dark theme —
 * see app/globals.css). Adjacent-pair chart forms (pie slices, stacked-bar
 * segments both only ever have their immediate neighbors on screen, never
 * an arbitrary pair) validate all 7 slots in this fixed order: worst
 * adjacent CVD ΔE 9.1 (protan/deuteranopia, OKLab ×100, ≥8 target), worst
 * adjacent normal-vision ΔE 19.6 (≥15 floor) — confirmed with
 * dataviz's scripts/validate_palette.js against this app's actual white
 * surface (#ffffff). Never cycled, never reordered per-chart — a source's
 * slot is fixed by buildSourceColorScale below and reused across every
 * chart on the page so the same source is always the same color.
 */
export const CATEGORICAL_PALETTE = [
  "#2a78d6", // 1 blue
  "#eb6834", // 2 orange
  "#1baf7a", // 3 aqua
  "#eda100", // 4 yellow
  "#e87ba4", // 5 magenta
  "#008300", // 6 green
  "#4a3aa7", // 7 violet
];

/** How many real sources get their own slice/segment before the rest fold
 * into "Other" — the dataviz series-count ladder's 7-8 token ceiling. */
export const TOP_N_CHART_SOURCES = CATEGORICAL_PALETTE.length;

export const OTHER_SOURCE_ID = "__other__";
export const OTHER_LABEL = "Other";

// Same neutral gray as --color-not-built-dot in app/globals.css — reused
// deliberately: "no single real identity" reads the same in both places.
export const OTHER_SLICE_COLOR = "#c1c5d0";

/** Assigns each of `topSourceIds` (already ranked, most-listings-first) the
 * next fixed palette slot, in order — the one place a source's color is
 * decided, so every chart on the page that calls this with the same
 * `topSourceIds` paints that source identically. Looking up any id not in
 * the map (including OTHER_SOURCE_ID) falls back to OTHER_SLICE_COLOR. */
export function buildSourceColorScale(topSourceIds: string[]): Map<string, string> {
  const scale = new Map<string, string>();
  topSourceIds.forEach((id, i) => {
    scale.set(id, CATEGORICAL_PALETTE[i % CATEGORICAL_PALETTE.length]);
  });
  return scale;
}

export function colorForSource(sourceId: string, scale: Map<string, string>): string {
  return scale.get(sourceId) ?? OTHER_SLICE_COLOR;
}

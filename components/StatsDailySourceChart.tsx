"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DailyStatsSnapshot } from "@/lib/statsStore";
import type { SourceBreakdownEntry } from "@/lib/sourceBreakdown";
import { buildDailyChartRows, groupTopSourcesWithOther, type GroupedSourceCount } from "@/lib/chartGrouping";
import { buildSourceColorScale, colorForSource } from "@/lib/chartPalette";

interface Props {
  daily: DailyStatsSnapshot[];
  bySource: SourceBreakdownEntry[]; // today's live counts — decides which sources get their own stack, same set StatsSourcePie uses
}

/** Same reasoning as StatsSourcePie's PieLegend: Recharts' auto-derived
 * legend re-sorts alphabetically, which would desync it from both the
 * actual stack order (bottom-to-top) and the pie chart's legend order —
 * bypass it with `content` and render straight from `stackKeys`. */
function BarLegend({ stackKeys, colorScale }: { stackKeys: GroupedSourceCount[]; colorScale: Map<string, string> }) {
  return (
    <ul className="stats-legend stats-legend--row">
      {stackKeys.map((s) => (
        <li key={s.sourceId} className="stats-legend__item">
          <span
            className="stats-legend__swatch stats-legend__swatch--square"
            style={{ background: colorForSource(s.sourceId, colorScale) }}
            aria-hidden
          />
          {s.sourceName}
        </li>
      ))}
    </ul>
  );
}

/** Per-source listings per day, stacked — part-to-whole over time
 * (dataviz: "part-to-whole → stacked bar", "tell distinct series apart →
 * categorical color"). Same top-7-plus-Other grouping and the exact same
 * per-source colors as StatsSourcePie, so a source reads as the same
 * identity in both charts. Graceful with little history: 1 day renders as
 * a single stacked column, not an error. */
export default function StatsDailySourceChart({ daily, bySource }: Props) {
  if (daily.length === 0) {
    return (
      <p className="stats-empty">
        No daily history yet — this builds up one entry per day starting from the first daily sync.
      </p>
    );
  }

  const { topSourceIds, grouped } = groupTopSourcesWithOther(bySource);
  const colorScale = buildSourceColorScale(topSourceIds);
  const rows = buildDailyChartRows(daily, topSourceIds);
  const stackKeys: GroupedSourceCount[] = grouped; // same order as the pie's legend

  return (
    <>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: "var(--color-text-muted)", fontSize: 12 }}
            axisLine={{ stroke: "var(--color-border)" }}
            tickLine={false}
          />
          <YAxis
            width={48}
            allowDecimals={false}
            tick={{ fill: "var(--color-text-muted)", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              fontSize: 13,
            }}
            formatter={(value) => Number(value).toLocaleString("en-GB")}
          />
          <Legend content={<BarLegend stackKeys={stackKeys} colorScale={colorScale} />} />
          {stackKeys.map((s) => (
            <Bar
              key={s.sourceId}
              dataKey={(row) => row.bySourceId[s.sourceId] ?? 0}
              name={s.sourceName}
              stackId="sources"
              fill={colorForSource(s.sourceId, colorScale)}
              maxBarSize={48}
              radius={s === stackKeys[stackKeys.length - 1] ? [4, 4, 0, 0] : undefined}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <p className="stats-caption">
        {rows.length} day{rows.length === 1 ? "" : "s"} of history recorded so far.
      </p>
    </>
  );
}

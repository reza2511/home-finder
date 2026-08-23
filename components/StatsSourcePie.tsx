"use client";

import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { SourceBreakdownEntry } from "@/lib/sourceBreakdown";
import { groupTopSourcesWithOther } from "@/lib/chartGrouping";
import { buildSourceColorScale, colorForSource } from "@/lib/chartPalette";

interface Props {
  bySource: SourceBreakdownEntry[]; // pre-sorted descending by count (GET /api/stats)
  total: number;
}

interface SliceDatum {
  sourceId: string;
  sourceName: string;
  listingCount: number;
  color: string;
}

/** Custom legend content, rendered directly from `data` in its real
 * most-listings-first order — Recharts' own auto-derived Pie legend
 * re-sorts entries alphabetically by name (confirmed live: slice colors
 * were correctly rank-assigned, but the legend listing them alongside was
 * not in that same order), and its typings don't expose a `payload`
 * override on the declarative <Legend>, so bypassing it with `content` is
 * the reliable fix. */
function PieLegend({ data }: { data: SliceDatum[] }) {
  return (
    <ul className="stats-legend">
      {data.map((d) => (
        <li key={d.sourceId} className="stats-legend__item">
          <span className="stats-legend__swatch" style={{ background: d.color }} aria-hidden />
          {d.sourceName}
          <span className="stats-legend__count">{d.listingCount.toLocaleString("en-GB")}</span>
        </li>
      ))}
    </ul>
  );
}

/** Part-to-whole by source. Past the palette's 7-source token ceiling, the
 * tail folds into a single gray "Other" slice (lib/chartGrouping.ts) rather
 * than generating more hues — three of the seven real slots (aqua, yellow,
 * magenta) sit below 3:1 contrast on this app's white surface, so identity
 * here deliberately never relies on slice color alone: the legend and
 * tooltip carry the name, and the exact count for every source (not just
 * the top 7) is in the table below this chart. */
export default function StatsSourcePie({ bySource, total }: Props) {
  if (bySource.length === 0) {
    return <p className="stats-empty">No active listings yet.</p>;
  }

  const { topSourceIds, grouped } = groupTopSourcesWithOther(bySource);
  const colorScale = buildSourceColorScale(topSourceIds);
  const data = grouped.map((g) => ({ ...g, color: colorForSource(g.sourceId, colorScale) }));

  return (
    <ResponsiveContainer width="100%" height={320}>
      <PieChart>
        <Pie
          data={data}
          dataKey="listingCount"
          nameKey="sourceName"
          cx="50%"
          cy="50%"
          innerRadius={70}
          outerRadius={120}
          paddingAngle={2}
          stroke="var(--color-surface)"
          strokeWidth={2}
        >
          {data.map((entry) => (
            <Cell key={entry.sourceId} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip
          formatter={(value, name) => {
            const n = Number(value);
            return [`${n.toLocaleString("en-GB")} (${((n / total) * 100).toFixed(1)}%)`, name];
          }}
          contentStyle={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            fontSize: 13,
          }}
        />
        <Legend layout="vertical" verticalAlign="middle" align="right" content={<PieLegend data={data} />} />
      </PieChart>
    </ResponsiveContainer>
  );
}

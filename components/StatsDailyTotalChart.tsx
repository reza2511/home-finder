"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DailyStatsSnapshot } from "@/lib/statsStore";
import { buildDailyChartRows } from "@/lib/chartGrouping";
import { CATEGORICAL_PALETTE } from "@/lib/chartPalette";

/** Total listings per day — a single series, so slot 1 (blue) alone, no
 * legend box needed (dataviz: "a single series needs no legend box — the
 * chart's title already says what is plotted"). Renders whatever history
 * actually exists rather than forcing a fixed window: 1 point shows as a
 * single dot, a handful of points as a short real line — never padded
 * with invented dates. */
export default function StatsDailyTotalChart({ daily }: { daily: DailyStatsSnapshot[] }) {
  if (daily.length === 0) {
    return (
      <p className="stats-empty">
        No daily history yet — this builds up one entry per day starting from the first daily sync.
      </p>
    );
  }

  const rows = buildDailyChartRows(daily, []);

  return (
    <>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
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
            formatter={(value) => [Number(value).toLocaleString("en-GB"), "Total listings"]}
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              fontSize: 13,
            }}
          />
          <Line
            type="monotone"
            dataKey="total"
            stroke={CATEGORICAL_PALETTE[0]}
            strokeWidth={2}
            dot={{ r: 4, fill: CATEGORICAL_PALETTE[0], strokeWidth: 0 }}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <p className="stats-caption">
        {rows.length} day{rows.length === 1 ? "" : "s"} of history recorded so far.
      </p>
    </>
  );
}

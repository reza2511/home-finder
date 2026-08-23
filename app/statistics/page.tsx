"use client";

import { useEffect, useState } from "react";
import Header from "@/components/Header";
import StatsHero from "@/components/StatsHero";
import StatsSourcePie from "@/components/StatsSourcePie";
import StatsSourceTable from "@/components/StatsSourceTable";
import StatsDailyTotalChart from "@/components/StatsDailyTotalChart";
import StatsDailySourceChart from "@/components/StatsDailySourceChart";
import type { SourceBreakdownEntry } from "@/lib/sourceBreakdown";
import type { DailyStatsSnapshot } from "@/lib/statsStore";

interface StatsResponse {
  totalCurrent: number;
  bySource: SourceBreakdownEntry[];
  daily: DailyStatsSnapshot[];
}

// Public — no login required, no auth check/redirect (same as /removed).
// GET /api/stats is itself unauthenticated too.
export default function StatisticsPage() {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/stats", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) {
          setError(d.error);
        } else {
          setData(d);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load statistics.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <Header />
      <main className="page-content">
        <h1 className="page-heading">Statistics</h1>
        <p className="page-subheading">
          Real counts from the live data — nothing here is estimated. Day-over-day trends build up
          from each daily sync, starting from when this page was added.
        </p>

        {error && <div className="status-banner status-banner--error">{error}</div>}

        {data === null && !error ? (
          <p className="listings-empty">Loading…</p>
        ) : data ? (
          <div className="stats-layout">
            <StatsHero total={data.totalCurrent} />

            <div className="stats-grid">
              <section className="stats-card">
                <h2 className="stats-card__heading">Listings by source</h2>
                <StatsSourcePie bySource={data.bySource} total={data.totalCurrent} />
              </section>

              <section className="stats-card">
                <h2 className="stats-card__heading">Current count per source</h2>
                <StatsSourceTable bySource={data.bySource} total={data.totalCurrent} />
              </section>
            </div>

            <section className="stats-card">
              <h2 className="stats-card__heading">Total listings over time</h2>
              <StatsDailyTotalChart daily={data.daily} />
            </section>

            <section className="stats-card">
              <h2 className="stats-card__heading">Listings by source over time</h2>
              <StatsDailySourceChart daily={data.daily} bySource={data.bySource} />
            </section>
          </div>
        ) : null}
      </main>
    </>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ComparisonTable from "@/components/ComparisonTable";
import { fetchSession } from "@/lib/authClient";
import { exportComparisonToExcel } from "@/lib/compareExport";
import type { CompareResult } from "@/lib/compareExtract";

const NUM_SLOTS = 10;

// Requires login (Stage A auth) — same real, server-side session cookie
// check protects POST /api/compare regardless of what this page does, but
// a public visitor is also redirected away from the page itself, rather
// than shown a working-looking form that would just 401 on submit.
export default function ComparePage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [urls, setUrls] = useState<string[]>(() => Array(NUM_SLOTS).fill(""));
  const [results, setResults] = useState<CompareResult[] | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((s) => {
        if (cancelled) return;
        setAuthenticated(s.authenticated);
        setAuthChecked(true);
        if (!s.authenticated) router.replace("/login");
      })
      .catch(() => {
        if (cancelled) return;
        setAuthChecked(true);
        router.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  function setUrlAt(index: number, value: string) {
    setUrls((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }

  async function handleCompare() {
    const nonEmpty = urls.map((u) => u.trim()).filter(Boolean);
    if (nonEmpty.length === 0) {
      setError("Enter at least one property URL.");
      return;
    }

    setComparing(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch("/api/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ urls: nonEmpty }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Compare failed (${res.status})`);
      }
      const data = await res.json();
      setResults(data.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Compare failed");
    } finally {
      setComparing(false);
    }
  }

  // Nothing rendered until the session check resolves (avoids flashing the
  // real form) or once it's confirmed unauthenticated (already redirecting).
  if (!authChecked || !authenticated) return null;

  return (
    <>
      <Header />
      <main className="page-content">
        <h1 className="page-heading">Compare properties</h1>
        <p className="page-subheading">
          Paste up to {NUM_SLOTS} property listing URLs, then compare them side by side. Each page is read
          live and extracted with AI — only what a page genuinely states is shown; anything it doesn&apos;t
          say, or a page that can&apos;t be read, is left blank rather than guessed.
        </p>

        <div className="compare-inputs">
          {urls.map((u, i) => (
            <input
              key={i}
              type="url"
              className="compare-inputs__field"
              placeholder={`Property URL ${i + 1}`}
              value={u}
              onChange={(e) => setUrlAt(i, e.target.value)}
              aria-label={`Property URL ${i + 1}`}
            />
          ))}
        </div>

        {error && <div className="status-banner status-banner--error">{error}</div>}

        <div className="compare-actions">
          <button type="button" className="btn btn--primary" onClick={handleCompare} disabled={comparing}>
            {comparing ? "Comparing… this can take a few minutes" : "Compare"}
          </button>
          {results && results.length > 0 && (
            <button type="button" className="btn btn--ghost" onClick={() => exportComparisonToExcel(results)}>
              Export to Excel
            </button>
          )}
        </div>

        {results && <ComparisonTable results={results} />}
      </main>
    </>
  );
}

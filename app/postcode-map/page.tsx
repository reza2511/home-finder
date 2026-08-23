"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import type { FeatureCollection, Geometry } from "geojson";
import Header from "@/components/Header";
import PostcodeDistrictPanel from "@/components/PostcodeDistrictPanel";
import type { DistrictProperties, SelectedDistrict } from "@/components/PostcodeMap";

// Leaflet touches `window`/the DOM at import time — it can only ever run
// in the browser, so the map itself is loaded client-side only, after
// hydration. ssr:false also means its (fairly large) JS + the boundary
// GeoJSON fetch don't block/appear in the server-rendered HTML for this
// page at all.
const PostcodeMap = dynamic(() => import("@/components/PostcodeMap"), {
  ssr: false,
  loading: () => <div className="postcode-map postcode-map--loading">Loading map…</div>,
});

type Districts = FeatureCollection<Geometry, DistrictProperties>;

// Public — no login required, no auth check/redirect (same as /removed
// and /statistics). Both requests below are themselves unauthenticated.
export default function PostcodeMapPage() {
  const [districts, setDistricts] = useState<Districts | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedDistrict | null>(null);

  useEffect(() => {
    let cancelled = false;

    // The boundary file is a static asset in public/ (not bundled into
    // the JS) — see scripts/build-postcode-boundaries.mjs for how it was
    // generated and exactly where its data comes from.
    Promise.all([
      fetch("/data/postcode-districts.geojson", { cache: "force-cache" }).then((r) => r.json()),
      fetch("/api/postcode-counts", { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(([districtsData, countsData]) => {
        if (cancelled) return;
        if (countsData.error) {
          setError(countsData.error);
          return;
        }
        setDistricts(districtsData);
        setCounts(countsData.counts);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load the postcode map.");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const { totalDistricts, totalCounted } = useMemo(() => {
    if (!districts || !counts) return { totalDistricts: 0, totalCounted: 0 };
    const codes = new Set(districts.features.map((f) => f.properties.code));
    let matched = 0;
    for (const [code, count] of Object.entries(counts)) {
      if (codes.has(code)) matched += count;
    }
    return { totalDistricts: districts.features.length, totalCounted: matched };
  }, [districts, counts]);

  return (
    <>
      <Header />
      <main className="page-content">
        <h1 className="page-heading">Postcode map</h1>
        <p className="page-subheading">
          Every London postcode district (E, EC, N, NW, SE, SW, W, WC, plus the outer areas), shaded and
          labelled. Click a district to see how many of your active listings have a postcode in it.
        </p>

        {error && <div className="status-banner status-banner--error">{error}</div>}

        {!error && (districts === null || counts === null) ? (
          <p className="listings-empty">Loading…</p>
        ) : !error ? (
          <div className="postcode-layout">
            <div className="postcode-layout__map">
              <PostcodeMap districts={districts!} counts={counts!} onSelect={setSelected} />
            </div>
            <div className="postcode-layout__panel">
              <PostcodeDistrictPanel selected={selected} totalDistricts={totalDistricts} totalCounted={totalCounted} />
            </div>
          </div>
        ) : null}

        <p className="postcode-attribution">
          District boundaries: <a href="https://github.com/missinglink/uk-postcode-polygons" target="_blank" rel="noreferrer">missinglink/uk-postcode-polygons</a>
          {" "}— an export of the KML files attached to Wikipedia&apos;s{" "}
          <a href="https://en.wikipedia.org/wiki/List_of_postcode_districts_in_the_United_Kingdom" target="_blank" rel="noreferrer">
            List of postcode districts in the United Kingdom
          </a>{" "}
          © Wikipedia contributors, licensed{" "}
          <a href="https://en.wikipedia.org/wiki/Wikipedia:Copyrights" target="_blank" rel="noreferrer">
            CC BY-SA 3.0
          </a>
          . Map tiles © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors.
        </p>
      </main>
    </>
  );
}

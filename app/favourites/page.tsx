"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ListingsGrid from "@/components/ListingsGrid";
import { fetchSession } from "@/lib/authClient";
import {
  favouriteKey,
  fetchFavourites,
  removeFavourite,
  type FavouriteRemoval,
} from "@/lib/favouritesClient";
import { formatDateTime } from "@/lib/relativeTime";
import type { Listing } from "@/lib/types";

// Requires login (Stage A auth), same as /compare — a public visitor is
// redirected to /login rather than shown a page that would just 401 on
// every request. The real protection is server-side on every /api/
// favourites route regardless of this redirect.
export default function FavouritesPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [favourites, setFavourites] = useState<Listing[] | null>(null);
  const [removals, setRemovals] = useState<FavouriteRemoval[]>([]);
  const [favKeys, setFavKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchSession()
      .then((s) => {
        if (cancelled) return;
        setAuthenticated(s.authenticated);
        setAuthChecked(true);
        if (!s.authenticated) {
          router.replace("/login");
          return;
        }
        return fetchFavourites().then((d) => {
          if (cancelled) return;
          setFavourites(d.favourites);
          setRemovals(d.removals);
          setFavKeys(new Set(d.favourites.map((l) => favouriteKey(l.sourceId, l.externalId))));
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setAuthChecked(true);
        setError(err instanceof Error ? err.message : "Failed to load favourites");
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  // Every card on this page is already a favourite, so toggling here only
  // ever means "remove" — optimistic, reverted if the server call fails.
  async function handleToggleFavourite(listing: Listing) {
    const key = favouriteKey(listing.sourceId, listing.externalId);
    setFavourites((prev) => (prev ?? []).filter((l) => favouriteKey(l.sourceId, l.externalId) !== key));
    setFavKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    try {
      await removeFavourite(listing.sourceId, listing.externalId);
    } catch (err) {
      setFavourites((prev) => [...(prev ?? []), listing]);
      setFavKeys((prev) => new Set(prev).add(key));
      setError(err instanceof Error ? err.message : "Failed to remove favourite");
    }
  }

  if (!authChecked || !authenticated) return null;

  return (
    <>
      <Header />
      <main className="page-content">
        <h1 className="page-heading">Favourites</h1>
        <p className="page-subheading">
          Properties you&apos;ve favourited. Private to your account — the public can&apos;t see this page.
        </p>

        {error && <div className="status-banner status-banner--error">{error}</div>}

        {removals.length > 0 && (
          <div className="favourites-removals">
            <h2 className="favourites-removals__heading">Removed favourites</h2>
            <p className="favourites-removals__subtitle">
              These were favourited but have since been delisted by their source (most recent {removals.length}
              {removals.length === 1 ? " removal" : " removals"}).
            </p>
            <ul className="favourites-removals__list">
              {removals.map((r) => (
                <li key={r.id} className="favourites-removals__item">
                  <a href={r.url} target="_blank" rel="noreferrer" className="favourites-removals__link">
                    {r.title}
                  </a>
                  <span className="favourites-removals__date">Removed {formatDateTime(r.removedAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {favourites === null ? (
          <p className="listings-loading">Loading favourites…</p>
        ) : (
          <ListingsGrid
            listings={favourites}
            favouriteKeys={favKeys}
            onToggleFavourite={handleToggleFavourite}
            emptyMessage="No favourites yet — click the heart on any property to save it here."
          />
        )}
      </main>
    </>
  );
}

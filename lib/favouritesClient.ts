import type { Listing } from "./types";

export interface FavouriteRemoval {
  id: string;
  sourceId: string;
  externalId: string;
  title: string;
  url: string;
  removedAt: string;
}

export function favouriteKey(sourceId: string, externalId: string): string {
  return `${sourceId}::${externalId}`;
}

export async function fetchFavouriteKeys(): Promise<Set<string>> {
  const res = await fetch("/api/favourites/keys", { cache: "no-store" });
  if (!res.ok) {
    if (res.status === 401) return new Set(); // not logged in — no favourites to show
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to load favourites (${res.status})`);
  }
  const data = await res.json();
  return new Set<string>(data.keys);
}

export async function fetchFavourites(): Promise<{ favourites: Listing[]; removals: FavouriteRemoval[] }> {
  const res = await fetch("/api/favourites", { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to load favourites (${res.status})`);
  }
  return res.json();
}

export async function addFavourite(sourceId: string, externalId: string): Promise<void> {
  const res = await fetch("/api/favourites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId, externalId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to add favourite (${res.status})`);
  }
}

export async function removeFavourite(sourceId: string, externalId: string): Promise<void> {
  const res = await fetch(
    `/api/favourites?sourceId=${encodeURIComponent(sourceId)}&externalId=${encodeURIComponent(externalId)}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to remove favourite (${res.status})`);
  }
}

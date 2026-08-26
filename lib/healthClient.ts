import type { HealthResponse } from "./types";

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load health status (${res.status})`);
  }
  return res.json();
}

/** Manually clears the drop-guard "needs my attention" flag — the only way
 * it ever clears (lib/dropGuard.ts's clearDropGuardFlag). Authenticated;
 * see app/api/health/acknowledge/route.ts. */
export async function acknowledgeDropGuard(): Promise<void> {
  const res = await fetch("/api/health/acknowledge", { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to acknowledge (${res.status})`);
  }
}

/** Absolute local date/time, e.g. "22 Aug 2026, 08:15" — used for the
 * refresh-history buttons, where a fixed point in time (not "3h ago") is
 * what actually distinguishes one snapshot from another. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "Never";

  const diffMs = Date.now() - Date.parse(iso);
  if (Number.isNaN(diffMs)) return "Never";
  if (diffMs < 45_000) return "just now";

  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;

  if (diffMs < hour) return `${Math.round(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.round(diffMs / hour)}h ago`;
  return `${Math.round(diffMs / day)}d ago`;
}

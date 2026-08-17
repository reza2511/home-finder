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

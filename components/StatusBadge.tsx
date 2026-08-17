import type { SourceStatus } from "@/lib/types";

const LABELS: Record<SourceStatus, string> = {
  ok: "Updated",
  no_results: "No results",
  blocked: "Blocked",
  error: "Error",
  stale: "Stale",
  not_built: "Not built",
};

export default function StatusBadge({ status }: { status: SourceStatus }) {
  return (
    <span className={`status-badge status-badge--${status}`}>
      <span className="status-badge__dot" aria-hidden />
      {LABELS[status]}
    </span>
  );
}

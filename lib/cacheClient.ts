export async function clearCache(): Promise<void> {
  const res = await fetch("/api/cache/clear", { method: "POST" });
  if (!res.ok) {
    throw new Error(`Failed to clear cache (${res.status})`);
  }
}

export interface SessionResponse {
  authenticated: boolean;
  username: string | null;
}

export async function fetchSession(): Promise<SessionResponse> {
  const res = await fetch("/api/auth/session", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load session (${res.status})`);
  }
  return res.json();
}

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Login failed (${res.status})`);
  }
}

export async function logout(): Promise<void> {
  const res = await fetch("/api/auth/logout", { method: "POST" });
  if (!res.ok) {
    throw new Error(`Logout failed (${res.status})`);
  }
}

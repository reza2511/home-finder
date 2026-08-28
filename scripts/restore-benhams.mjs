import fs from "fs";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const BASE = "http://localhost:3002";

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "reza", password: env.AUTH_PASSWORD }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Login failed: ${JSON.stringify(body)}`);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("No session cookie returned");
  return cookie;
}

const cookie = await login();
console.log("Logged in. Syncing benhams (with the hardened Load-more pagination)...");
const startedAt = Date.now();
const res = await fetch(`${BASE}/api/sync?ids=benhams`, { method: "POST", headers: { cookie } });
const body = await res.json().catch(() => null);
console.log(`Status ${res.status}, ${Date.now() - startedAt}ms:`, JSON.stringify(body, null, 2));

import { NextResponse } from "next/server";
import {
  AUTH_USERNAME,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  verifyCredentials,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

export async function POST(request: Request) {
  let body: LoginBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!process.env.AUTH_PASSWORD) {
    // Never fall back to a hardcoded password — an unconfigured server
    // means login is genuinely unavailable, not "wide open".
    return NextResponse.json(
      { error: "Login isn't configured on this server (AUTH_PASSWORD is not set)." },
      { status: 500 }
    );
  }

  if (!verifyCredentials(username, password)) {
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }

  const token = createSessionToken();
  const res = NextResponse.json({ ok: true, username: AUTH_USERNAME });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}

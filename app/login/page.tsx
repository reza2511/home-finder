"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/lib/authClient";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(username, password);
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-card__brand">
          <span className="app-header__logo" aria-hidden>
            🏠
          </span>
          <span className="app-header__title">Home Finder</span>
        </div>
        <h1 className="login-card__heading">Log in</h1>

        {error && <div className="status-banner status-banner--error">{error}</div>}

        <label className="login-field">
          <span className="filter-group__label">Username</span>
          <input
            type="text"
            className="filter-number login-field__input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>

        <label className="login-field">
          <span className="filter-group__label">Password</span>
          <input
            type="password"
            className="filter-number login-field__input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <button type="submit" className="btn btn--primary login-card__submit" disabled={submitting}>
          {submitting ? "Logging in…" : "Log in"}
        </button>
      </form>
    </main>
  );
}

"use client";

import { useState } from "react";

type Result = {
  ok: boolean;
  message: string;
};

export function SendToInstantlyButton({
  institutionId,
  hasEmail,
}: {
  institutionId: number;
  hasEmail: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function send() {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch(`/api/instantly/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ institutionId }),
      });
      const data = (await r.json()) as Result;
      setResult(data);
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setBusy(false);
    }
  }

  if (!hasEmail) {
    return (
      <div className="rounded-md border border-fl-mango/40 bg-fl-mango/10 px-3 py-2 text-sm text-fl-navy">
        No contact email on record — add one before pushing to Instantly.
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={send}
        disabled={busy}
        className="fl-cta inline-flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-semibold shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? (
          <span
            aria-hidden
            className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white"
          />
        ) : (
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2.5 10 17.5 3 14 17l-4-6.5L2.5 10z" />
          </svg>
        )}
        {busy ? "Sending…" : "Send to Instantly"}
      </button>
      {result ? (
        <span
          className={
            "text-sm " +
            (result.ok ? "text-emerald-700" : "text-fl-orange")
          }
        >
          {result.message}
        </span>
      ) : null}
    </div>
  );
}

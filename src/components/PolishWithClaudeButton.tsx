"use client";

import { useState } from "react";
import { CopyButton } from "./CopyButton";

type PolishResponse =
  | {
      ok: true;
      cached: boolean;
      subject: string;
      body: string;
      model: string;
      inputTokens?: number;
      outputTokens?: number;
    }
  | { ok: false; message: string };

export function PolishWithClaudeButton({
  institutionId,
}: {
  institutionId: number;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PolishResponse | null>(null);

  async function polish(force = false) {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch("/api/polish-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ institutionId, force }),
      });
      const data = (await r.json()) as PolishResponse;
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => polish(false)}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-md border border-fl-blue/40 bg-fl-blue/10 px-3.5 py-1.5 text-sm font-semibold text-fl-blue transition-colors hover:bg-fl-blue hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (
            <span
              aria-hidden
              className="h-3 w-3 animate-spin rounded-full border-2 border-fl-blue/40 border-t-fl-blue"
            />
          ) : (
            <svg
              aria-hidden
              viewBox="0 0 20 20"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 17 17 3M9 3h8v8" />
              <path d="M11 9.5 14.5 6" />
            </svg>
          )}
          {busy ? "Polishing…" : "Polish with Claude"}
        </button>
        {result?.ok && result.cached ? (
          <button
            type="button"
            onClick={() => polish(true)}
            disabled={busy}
            className="text-xs font-medium text-fl-navy/55 underline-offset-2 hover:text-fl-navy hover:underline"
          >
            Re-polish
          </button>
        ) : null}
      </div>

      {result && !result.ok ? (
        <div className="rounded-md border border-fl-orange/40 bg-fl-orange/5 px-3 py-2 text-sm text-fl-navy">
          {result.message}
        </div>
      ) : null}

      {result?.ok ? (
        <div className="rounded-md border border-fl-blue/30 bg-fl-blue/5 p-4">
          <div className="mb-3 flex items-center gap-2 text-xs">
            <span className="rounded-full bg-fl-blue/15 px-2 py-0.5 font-semibold uppercase tracking-wider text-fl-blue">
              Polished by Claude
            </span>
            <span className="text-fl-navy/55">
              {result.cached
                ? "served from cache"
                : `${result.inputTokens ?? "?"} in / ${result.outputTokens ?? "?"} out tokens · ${result.model}`}
            </span>
          </div>
          <p className="text-sm font-semibold text-fl-navy">
            <span className="text-fl-navy/55">Subject:</span> {result.subject}
          </p>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed text-fl-navy">
            {result.body}
          </pre>
          <div className="mt-3 flex items-center gap-2">
            <CopyButton
              text={`Subject: ${result.subject}\n\n${result.body}`}
              label="Copy polished email"
              variant="primary"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

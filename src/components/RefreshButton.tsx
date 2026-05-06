"use client";

import { useEffect, useRef, useState } from "react";

type Status = {
  state: "idle" | "running" | "success" | "failed";
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  stages?: { source: string; status: string; recordsUpserted: number }[];
};

export function RefreshButton() {
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function loadStatus() {
    try {
      const r = await fetch("/api/refresh", { cache: "no-store" });
      const data = (await r.json()) as Status;
      setStatus(data);
      if (data.state !== "running" && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setBusy(false);
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    void loadStatus();
  }, []);

  async function start() {
    setBusy(true);
    try {
      const r = await fetch("/api/refresh", { method: "POST" });
      if (!r.ok) {
        setBusy(false);
        return;
      }
      pollRef.current = setInterval(loadStatus, 1500);
      void loadStatus();
    } catch {
      setBusy(false);
    }
  }

  const running = status.state === "running" || busy;
  const label = running
    ? "Refreshing…"
    : status.state === "failed"
      ? "Retry refresh"
      : "Refresh data";

  return (
    <div className="flex items-center gap-3">
      {status.state !== "idle" && status.message ? (
        <span className="hidden text-xs text-white/70 md:inline">
          {status.message}
        </span>
      ) : null}
      <button
        onClick={start}
        disabled={running}
        className="fl-cta inline-flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-semibold shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
      >
        {running ? (
          <span
            aria-hidden
            className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white"
          />
        ) : null}
        {label}
      </button>
    </div>
  );
}

"use client";

import { useState } from "react";

export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  variant = "outline",
  className = "",
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  variant?: "outline" | "primary";
  className?: string;
}) {
  const [done, setDone] = useState(false);

  const variantClass =
    variant === "primary"
      ? "fl-cta"
      : "border border-fl-navy/15 bg-white text-fl-navy hover:bg-fl-off-white";

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className={
        "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
        variantClass +
        " " +
        className
      }
    >
      {done ? (
        <>
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="4 11 8 15 16 5" />
          </svg>
          {copiedLabel}
        </>
      ) : (
        <>
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="6" y="6" width="11" height="11" rx="2" />
            <path d="M3 13V4a1 1 0 0 1 1-1h9" />
          </svg>
          {label}
        </>
      )}
    </button>
  );
}

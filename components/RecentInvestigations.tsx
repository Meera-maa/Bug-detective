"use client";

import Link from "next/link";
import { clearHistory, removeRecord, useHistory } from "@/lib/storage";
import type { Severity } from "@/lib/types";
import { card } from "./ui";

const DOT: Record<Severity, { color: string; label: string }> = {
  red: { color: "bg-danger", label: "Critical error" },
  orange: { color: "bg-warn", label: "Server or network error" },
  yellow: { color: "bg-caution", label: "Warning-level error" },
};

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

export function RecentInvestigations() {
  const { records, ready } = useHistory();

  return (
    <section className={`${card} p-4`} aria-labelledby="recent-heading">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="recent-heading" className="text-sm font-semibold">
          Recent Investigations
        </h2>
        {records.length > 0 && (
          <button
            type="button"
            className="rounded text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
            onClick={() => {
              if (window.confirm("Remove all recent investigations from this browser?")) clearHistory();
            }}
          >
            Clear all
          </button>
        )}
      </div>

      {!ready ? (
        <div className="space-y-2" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 rounded-md bg-panel2" />
          ))}
        </div>
      ) : records.length === 0 ? (
        <p className="rounded-md border border-dashed border-line-strong px-3 py-5 text-sm leading-relaxed text-muted">
          No investigations yet. Paste an error and its code, or load one of the demo bugs, and your cases will be kept here.
        </p>
      ) : (
        <ul className="-mx-1 space-y-0.5">
          {records.map((r) => (
            <li key={r.id} className="group flex items-center gap-1">
              <Link
                href={`/investigation/${r.id}`}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 hover:bg-panel2"
              >
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[r.severity].color}`} aria-hidden="true" />
                <span className="sr-only">{DOT[r.severity].label}: </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{r.title}</span>
                  <span className="block text-xs text-faint">
                    {timeAgo(r.createdAt)}
                    {r.test ? " · test generated" : ""}
                  </span>
                </span>
              </Link>
              <button
                type="button"
                onClick={() => removeRecord(r.id)}
                className="rounded px-2 py-1 text-xs text-faint opacity-100 hover:text-danger sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                aria-label={`Remove ${r.title}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-faint">Saved only in this browser.</p>
    </section>
  );
}

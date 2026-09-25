"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { InvestigationRecord } from "@/lib/types";
import { useRecord } from "@/lib/storage";
import { btnPrimary, card } from "./ui";

/** Waits for browser storage, and shows a friendly screen when an investigation cannot be found. */
export function RecordGate({ id, children }: { id: string; children: (record: InvestigationRecord) => ReactNode }) {
  const { record, ready } = useRecord(id);

  if (!ready) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading investigation">
        <div className="h-8 w-64 rounded bg-panel2" />
        <div className="h-24 rounded-lg bg-panel" />
        <div className="h-40 rounded-lg bg-panel" />
      </div>
    );
  }

  if (!record) {
    return (
      <div className={`${card} mx-auto max-w-lg space-y-3 p-8 text-center`}>
        <h1 className="text-xl font-semibold">Investigation not found</h1>
        <p className="text-sm leading-relaxed text-muted">
          Investigations are saved only in the browser that created them, so this one may have been cleared or opened on another device. Start a new one to continue.
        </p>
        <Link href="/" className={`${btnPrimary} mt-2`}>
          Start a new investigation
        </Link>
      </div>
    );
  }

  return <>{children(record)}</>;
}

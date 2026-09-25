"use client";

import Link from "next/link";
import { btnPrimary, btnSecondary, card } from "@/components/ui";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className={`${card} mx-auto max-w-lg space-y-3 p-8 text-center`} role="alert">
      <h1 className="text-xl font-semibold">Something went wrong on this page</h1>
      <p className="text-sm text-muted">Your saved investigations are safe. Try again, or go back to the start.</p>
      <div className="mt-2 flex justify-center gap-2">
        <button type="button" onClick={reset} className={btnPrimary}>
          Try again
        </button>
        <Link href="/" className={btnSecondary}>
          Home
        </Link>
      </div>
    </div>
  );
}

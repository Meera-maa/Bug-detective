import Link from "next/link";
import { btnPrimary, card } from "@/components/ui";

export default function NotFound() {
  return (
    <div className={`${card} mx-auto max-w-lg space-y-3 p-8 text-center`}>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted">This page does not exist. Start an investigation from the home page.</p>
      <Link href="/" className={`${btnPrimary} mt-2`}>
        Back to Bug Detective
      </Link>
    </div>
  );
}

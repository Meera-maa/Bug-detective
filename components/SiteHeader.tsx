import Link from "next/link";

export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="14" cy="14" r="8" fill="none" stroke="var(--accent)" strokeWidth="2.6" />
      <path d="M20 20l7 7" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="14" cy="14" r="2.4" fill="var(--red)" />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 rounded-md">
          <LogoMark />
          <span className="text-[15px] font-semibold tracking-tight">Bug Detective</span>
        </Link>
        <p className="hidden text-sm text-muted sm:block">Investigate. Fix. Verify.</p>
      </div>
    </header>
  );
}

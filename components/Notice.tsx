import type { ReactNode } from "react";

type Tone = "error" | "warning" | "success" | "info";

const TONES: Record<Tone, string> = {
  error: "border-danger/40 bg-danger/10 text-ink",
  warning: "border-warn/40 bg-warn/10 text-ink",
  success: "border-ok/40 bg-ok/10 text-ink",
  info: "border-line-strong bg-panel2 text-ink",
};

const ICONS: Record<Tone, string> = { error: "✕", warning: "!", success: "✓", info: "i" };
const ICON_COLORS: Record<Tone, string> = { error: "text-danger", warning: "text-warn", success: "text-ok", info: "text-muted" };

export function Notice({ tone, title, children, actions }: { tone: Tone; title?: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div role={tone === "error" || tone === "warning" ? "alert" : "status"} className={`flex gap-3 rounded-lg border px-4 py-3 text-sm ${TONES[tone]}`}>
      <span aria-hidden="true" className={`mt-0.5 font-mono font-bold ${ICON_COLORS[tone]}`}>
        {ICONS[tone]}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-muted [&_strong]:text-ink">{children}</div>}
        {actions && <div className="flex flex-wrap gap-2 pt-2">{actions}</div>}
      </div>
    </div>
  );
}

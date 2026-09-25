import type { ReactNode } from "react";

/** Read-only code with line numbers. Long lines scroll sideways instead of breaking the page. */
export function CodeBlock({ code, label, action, maxHeight = "28rem" }: { code: string; label?: string; action?: ReactNode; maxHeight?: string }) {
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <figure className="overflow-hidden rounded-lg border border-line bg-code">
      {(label || action) && (
        <figcaption className="flex items-center justify-between gap-3 border-b border-line bg-panel px-3 py-2">
          <span className="truncate font-mono text-xs text-muted">{label}</span>
          {action}
        </figcaption>
      )}
      <div className="scroll-thin overflow-auto py-3" style={{ maxHeight }} tabIndex={0} aria-label={label ? `Code: ${label}` : "Code"}>
        <pre className="min-w-max font-mono text-[13px] leading-6">
          {lines.map((line, i) => (
            <div key={i} className="flex px-3">
              <span className="w-8 shrink-0 select-none pr-3 text-right text-faint">{i + 1}</span>
              <code className="whitespace-pre text-ink/95">{line || " "}</code>
            </div>
          ))}
        </pre>
      </div>
    </figure>
  );
}

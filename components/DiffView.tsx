"use client";

import { useState } from "react";
import { diffLines } from "@/lib/diff";
import { CodeBlock } from "./CodeBlock";
import { CopyButton } from "./CopyButton";

const tab = (active: boolean) =>
  `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${active ? "bg-panel2 text-ink" : "text-muted hover:text-ink"}`;

/** Shows exactly what the suggested fix changes. Nothing is applied to the user's code automatically. */
export function DiffView({ before, after }: { before: string; after: string }) {
  const [view, setView] = useState<"changes" | "fixed">("changes");
  const diff = diffLines(before, after);
  const showFixed = view === "fixed" || diff === null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="tablist" aria-label="Fix view">
          <button type="button" role="tab" aria-selected={!showFixed} className={tab(!showFixed)} onClick={() => setView("changes")} disabled={diff === null}>
            Changes
          </button>
          <button type="button" role="tab" aria-selected={showFixed} className={tab(showFixed)} onClick={() => setView("fixed")}>
            Fixed code
          </button>
        </div>
        <CopyButton text={after} label="Copy fixed code" />
      </div>

      {showFixed ? (
        <CodeBlock code={after} label="fixed code" />
      ) : (
        <figure className="overflow-hidden rounded-lg border border-line bg-code">
          <figcaption className="border-b border-line bg-panel px-3 py-2 font-mono text-xs text-muted">before → after</figcaption>
          <div className="scroll-thin max-h-[28rem] overflow-auto py-2" tabIndex={0} aria-label="Code changes">
            <pre className="min-w-max font-mono text-[13px] leading-6">
              {diff.map((l, i) => (
                <div
                  key={i}
                  className={`flex px-3 ${l.type === "add" ? "bg-ok/10" : l.type === "remove" ? "bg-danger/10" : ""}`}
                >
                  <span className="w-8 shrink-0 select-none pr-2 text-right text-faint">{l.newLine ?? l.oldLine}</span>
                  <span
                    aria-hidden="true"
                    className={`w-5 shrink-0 select-none text-center ${l.type === "add" ? "text-ok" : l.type === "remove" ? "text-danger" : "text-faint"}`}
                  >
                    {l.type === "add" ? "+" : l.type === "remove" ? "−" : ""}
                  </span>
                  <span className="sr-only">{l.type === "add" ? "Added: " : l.type === "remove" ? "Removed: " : "Unchanged: "}</span>
                  <code className={`whitespace-pre ${l.type === "same" ? "text-ink/70" : "text-ink"}`}>{l.text || " "}</code>
                </div>
              ))}
            </pre>
          </div>
        </figure>
      )}
      <p className="text-sm text-muted">Nothing has been changed in your files. Review the changes, then apply them yourself.</p>
    </div>
  );
}

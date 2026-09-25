import { Fragment } from "react";

/** Renders `code` spans inside plain text (the AI returns simple backtick markup). */
export function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
          <code key={i} className="rounded border border-line bg-code px-1.5 py-0.5 font-mono text-[0.85em] text-ink">
            {part.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** Paragraphs separated by blank lines; lines starting with "- " become a bullet list. */
export function Prose({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return (
    <div className="space-y-3 text-[15px] leading-relaxed text-ink/90">
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        const bullets = lines.filter((l) => l.trim().startsWith("- "));
        if (bullets.length > 0) {
          const intro = lines.filter((l) => !l.trim().startsWith("- "));
          return (
            <div key={i} className="space-y-2">
              {intro.length > 0 && (
                <p>
                  <Inline text={intro.join(" ")} />
                </p>
              )}
              <ul className="list-disc space-y-1.5 pl-5 marker:text-faint">
                {bullets.map((b, j) => (
                  <li key={j}>
                    <Inline text={b.trim().slice(2)} />
                  </li>
                ))}
              </ul>
            </div>
          );
        }
        return (
          <p key={i}>
            <Inline text={lines.join(" ")} />
          </p>
        );
      })}
    </div>
  );
}

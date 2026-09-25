const STEPS = ["Bug", "Root cause", "Fix", "Test", "Verify"] as const;

/**
 * The case file: Bug → Root cause → Fix → Test → Verify.
 * `done` steps are complete, the step at index `done` is the current one.
 */
export function Stepper({ done }: { done: number }) {
  return (
    <ol className="flex w-full items-start" aria-label="Investigation progress">
      {STEPS.map((label, i) => {
        const complete = i < done;
        const current = i === done;
        return (
          <li key={label} className="relative flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center" aria-current={current ? "step" : undefined}>
            {i > 0 && (
              <span
                aria-hidden="true"
                className={`absolute right-1/2 top-[13px] h-px w-full ${i <= done ? "bg-accent/60" : "bg-line-strong"}`}
              />
            )}
            <span
              className={`relative z-10 flex h-[26px] w-[26px] items-center justify-center rounded-full border text-xs font-semibold ${
                complete
                  ? "border-accent bg-accent text-accent-ink"
                  : current
                    ? "border-accent bg-bg text-accent ring-4 ring-accent/15"
                    : "border-line-strong bg-bg text-faint"
              }`}
            >
              {complete ? "✓" : i + 1}
            </span>
            <span className={`text-xs sm:text-[13px] ${complete || current ? "text-ink" : "text-faint"}`}>
              {label}
              <span className="sr-only">{complete ? " (done)" : current ? " (current step)" : ""}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

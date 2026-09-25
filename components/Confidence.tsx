import type { Confidence as Level } from "@/lib/types";

const CONFIG: Record<Level, { filled: number; color: string; text: string }> = {
  High: { filled: 3, color: "bg-ok", text: "The error, the stack trace and the code point to the same place." },
  Medium: { filled: 2, color: "bg-caution", text: "The clues fit, but part of the picture is missing. Confirm the cause before shipping the fix." },
  Low: { filled: 1, color: "bg-warn", text: "Treat this as a lead, not a conclusion. More context (the real data, the full stack trace) would sharpen it." },
};

export function Confidence({ level }: { level: Level }) {
  const c = CONFIG[level];
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-3">
        <div className="flex gap-1" aria-hidden="true">
          {[1, 2, 3].map((n) => (
            <span key={n} className={`h-2 w-8 rounded-full ${n <= c.filled ? c.color : "bg-line-strong"}`} />
          ))}
        </div>
        <span className="text-lg font-semibold">{level}</span>
        <span className="sr-only">{`confidence: ${c.filled} of 3`}</span>
      </div>
      <p className="text-sm leading-relaxed text-muted">{c.text}</p>
    </div>
  );
}

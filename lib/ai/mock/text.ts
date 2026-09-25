export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Finds the first valid JSON object embedded anywhere in a block of text. */
export function findJsonObject(text: string): Record<string, unknown> | null {
  const last = text.lastIndexOf("}");
  if (last === -1) return null;
  for (let start = text.indexOf("{"); start !== -1 && start < last; start = text.indexOf("{", start + 1)) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, last + 1));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Serialises a value as a readable JavaScript literal: { user: { name: "Meera" } } */
export function jsLiteral(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jsLiteral).join(", ")}]`;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  const body = entries
    .map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${jsLiteral(v)}`)
    .join(", ");
  return `{ ${body} }`;
}

export function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "").trim();
}

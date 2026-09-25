import type { ApiError, GeneratedTest, InvestigationInput, InvestigationResult } from "@/lib/types";
import { parseGeneratedTest, parseInvestigationResult } from "@/lib/validate";

/** An error that already has a message that is safe and useful to show to the user. */
export class UserFacingError extends Error {
  constructor(
    message: string,
    readonly code: ApiError["code"] | "NETWORK" | "TIMEOUT_CLIENT" = "INTERNAL",
  ) {
    super(message);
    this.name = "UserFacingError";
  }
}

const GENERIC = "Investigation could not be completed. Please check your input or try again.";
const CLIENT_TIMEOUT_MS = 30_000;

async function post(url: string, body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new UserFacingError("This is taking longer than expected. Please try again, or paste a smaller piece of code.", "TIMEOUT_CLIENT");
    }
    throw new UserFacingError("Could not reach the server. Check your connection and try again.", "NETWORK");
  } finally {
    clearTimeout(timer);
  }

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // not JSON (for example an HTML error page)
  }

  if (!response.ok) {
    const err = (data as { error?: ApiError } | null)?.error;
    throw new UserFacingError(err?.message ?? GENERIC, err?.code ?? "INTERNAL");
  }
  if (data === null) throw new UserFacingError(GENERIC, "MALFORMED_RESPONSE");
  return data;
}

export async function investigate(input: InvestigationInput): Promise<{ result: InvestigationResult; provider: string }> {
  const data = (await post("/api/investigate", input)) as { result?: unknown; provider?: unknown };
  const parsed = parseInvestigationResult(data.result);
  if (!parsed.ok) throw new UserFacingError("The AI response could not be understood. Please try again.", "MALFORMED_RESPONSE");
  return { result: parsed.value, provider: typeof data.provider === "string" ? data.provider : "Unknown" };
}

export async function generateTest(input: InvestigationInput, result: InvestigationResult): Promise<GeneratedTest> {
  const data = (await post("/api/generate-test", { input, result })) as { test?: unknown };
  const parsed = parseGeneratedTest(data.test);
  if (!parsed.ok) throw new UserFacingError("The AI response could not be understood. Please try again.", "MALFORMED_RESPONSE");
  return parsed.value;
}

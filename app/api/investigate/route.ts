import { NextResponse } from "next/server";
import { getProvider } from "@/lib/ai";
import { PROVIDER_TIMEOUT_MS, fail, providerFailure, withTimeout } from "@/lib/api-helpers";
import { parseInvestigationInput, parseInvestigationResult } from "@/lib/validate";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_INPUT", "The request was not valid JSON.");
  }

  const input = parseInvestigationInput(body);
  if (!input.ok) return fail("INVALID_INPUT", input.message);

  const provider = getProvider();
  try {
    const raw = await withTimeout(provider.investigate(input.value), PROVIDER_TIMEOUT_MS);
    // Never trust the AI: check the shape before it reaches the UI.
    const parsed = parseInvestigationResult(raw);
    if (!parsed.ok) {
      console.error("[bug-detective] malformed AI response:", parsed.message);
      return fail("MALFORMED_RESPONSE", "The AI response could not be understood. Please try again.");
    }
    return NextResponse.json({ result: parsed.value, provider: provider.name });
  } catch (e) {
    return providerFailure(e);
  }
}

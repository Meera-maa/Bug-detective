import { NextResponse } from "next/server";
import { getProvider } from "@/lib/ai";
import { PROVIDER_TIMEOUT_MS, fail, providerFailure, withTimeout } from "@/lib/api-helpers";
import { parseGeneratedTest, parseInvestigationInput, parseInvestigationResult } from "@/lib/validate";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_INPUT", "The request was not valid JSON.");
  }

  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const input = parseInvestigationInput(record.input);
  if (!input.ok) return fail("INVALID_INPUT", input.message);
  const result = parseInvestigationResult(record.result);
  if (!result.ok) return fail("INVALID_INPUT", "The investigation result is missing or invalid. Run the investigation again.");

  const provider = getProvider();
  try {
    const raw = await withTimeout(provider.generateTest(input.value, result.value), PROVIDER_TIMEOUT_MS);
    const parsed = parseGeneratedTest(raw);
    if (!parsed.ok) {
      console.error("[bug-detective] malformed AI test response:", parsed.message);
      return fail("MALFORMED_RESPONSE", "The AI response could not be understood. Please try again.");
    }
    return NextResponse.json({ test: parsed.value, provider: provider.name });
  } catch (e) {
    return providerFailure(e);
  }
}

import { NextResponse } from "next/server";
import type { ApiError, ApiErrorCode } from "./types";
import { MalformedResponseError, ProviderUnavailableError } from "./ai/provider";

const STATUS: Record<ApiErrorCode, number> = {
  INVALID_INPUT: 400,
  PROVIDER_UNAVAILABLE: 503,
  MALFORMED_RESPONSE: 502,
  TIMEOUT: 504,
  INTERNAL: 500,
};

export function fail(code: ApiErrorCode, message: string) {
  const body: { error: ApiError } = { error: { code, message } };
  return NextResponse.json(body, { status: STATUS[code] });
}

export class TimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const PROVIDER_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS ?? 25_000);

/** Turns anything thrown while calling a provider into a friendly API error. */
export function providerFailure(e: unknown) {
  if (e instanceof TimeoutError) {
    return fail("TIMEOUT", "The investigation took too long. Please try again, or paste a smaller piece of code.");
  }
  if (e instanceof ProviderUnavailableError) {
    return fail("PROVIDER_UNAVAILABLE", "The AI provider is unavailable right now. Please try again in a moment.");
  }
  if (e instanceof MalformedResponseError) {
    return fail("MALFORMED_RESPONSE", "The AI response could not be understood. Please try again.");
  }
  console.error("[bug-detective] unexpected provider error:", e instanceof Error ? e.message : "unknown");
  return fail("INTERNAL", "Investigation could not be completed. Please check your input or try again.");
}

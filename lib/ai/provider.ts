import type { GeneratedTest, InvestigationInput, InvestigationResult } from "@/lib/types";

/**
 * Every AI backend (IBM Bob, the built-in mock, anything else) implements this.
 * Providers return `unknown` on purpose: the API routes validate the shape
 * before anything reaches the UI, so a misbehaving model can never break a screen.
 */
export interface AIProvider {
  /** Shown in the UI so users always know what produced the analysis. */
  readonly name: string;
  investigate(input: InvestigationInput): Promise<unknown>;
  generateTest(input: InvestigationInput, result: InvestigationResult): Promise<unknown>;
}

/** Throw this when the provider cannot be reached or is not configured. */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/** Throw this when the provider answered, but not with usable JSON. */
export class MalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedResponseError";
  }
}

export type { GeneratedTest };

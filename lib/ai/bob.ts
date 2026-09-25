/**
 * IBM Bob — Role in this project
 * ================================
 * IBM Bob 2.0 is the AI development assistant (the coding agent) that was used to BUILD this
 * application. It is not a callable runtime API. There is no IBM Bob HTTP endpoint, SDK, or
 * API key that an application can use to send prompts at runtime.
 *
 * What this means for Bug Detective:
 *   - The working AI analysis flow is the MockProvider (lib/ai/mock/).
 *     It was designed, written, and tested with IBM Bob as the development agent.
 *   - This file exists to document the distinction and to preserve the integration slot
 *     in case a future IBM product ships a callable API with compatible semantics.
 *
 * If a callable IBM AI API becomes available, implement `askBob()` below, add the
 * required credentials to .env.local (server-side only, never NEXT_PUBLIC_*), and
 * set AI_PROVIDER=bob. The rest of the pipeline (validation, UI, test runner) is
 * already wired up and will work without further changes.
 *
 * See BOB_CONTRIBUTIONS.md for what IBM Bob (as a dev agent) actually built in this project.
 */

import type { GeneratedTest, InvestigationInput, InvestigationResult } from "@/lib/types";
import { extractJson } from "@/lib/validate";
import { MalformedResponseError, ProviderUnavailableError, type AIProvider } from "./provider";

export class IbmBobProvider implements AIProvider {
  readonly name = "IBM Bob";

  async investigate(input: InvestigationInput): Promise<unknown> {
    const reply = await askBob(buildInvestigationPrompt(input));
    return parseReply(reply);
  }

  async generateTest(input: InvestigationInput, result: InvestigationResult): Promise<unknown> {
    const reply = await askBob(buildTestPrompt(input, result));
    return parseReply(reply);
  }
}

function parseReply(reply: string): unknown {
  try {
    return extractJson(reply);
  } catch {
    throw new MalformedResponseError("IBM Bob replied, but not with valid JSON.");
  }
}

/**
 * TO CONNECT A CALLABLE IBM AI API: replace this stub with a real HTTP call.
 * Throw ProviderUnavailableError if the service cannot be reached or is not configured.
 * Keep credentials in server-side environment variables only (never NEXT_PUBLIC_*).
 */
async function askBob(_prompt: string): Promise<string> {
  throw new ProviderUnavailableError(
    "IBM Bob is the development agent for this project, not a runtime API. " +
    "The application runs on the built-in analyzer (AI_PROVIDER=mock). " +
    "See lib/ai/bob.ts for details on how to connect a callable AI API if one becomes available.",
  );
}

const SYSTEM_RULES = `You are a careful debugging assistant.
Base every statement on the input provided. Never invent evidence, files, or code that is not shown.
If you are unsure, say so and lower the confidence.
Reply with a single JSON object and nothing else (no markdown fences, no commentary).`;

export function buildInvestigationPrompt(input: InvestigationInput): string {
  return `${SYSTEM_RULES}

Language: ${input.language}

Error message:
${input.error}

Stack trace:
${input.stackTrace ?? "(none)"}

Code:
${input.code}

Return JSON with exactly these fields:
{
  "problem": string,            // one sentence: what is going wrong
  "rootCause": string,          // the most likely cause, in plain language
  "evidence": string[],         // clues taken from the input above (quote code with backticks)
  "confidence": "Low" | "Medium" | "High",
  "suggestedFix": string,       // what to change, why it works, side effects or assumptions
  "testSuggestion": string,     // what a regression test should cover
  "fixedCode": string           // optional: the full corrected code
}`;
}

export function buildTestPrompt(input: InvestigationInput, result: InvestigationResult): string {
  return `${SYSTEM_RULES}

Language: ${input.language}

Original code:
${input.code}

Diagnosis: ${result.rootCause}
Suggested fix: ${result.suggestedFix}
${result.fixedCode ? `Fixed code:\n${result.fixedCode}\n` : ""}
Write a regression test (Vitest/Jest style) that fails on the original code and passes on the fix.
Cover the normal case, the null/undefined case, the empty case and one relevant edge case.

Return JSON with exactly these fields:
{
  "framework": string,
  "filename": string,
  "code": string,
  "covers": string[]
}`;
}

export type { GeneratedTest };

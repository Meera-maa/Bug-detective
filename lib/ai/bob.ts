import type { GeneratedTest, InvestigationInput, InvestigationResult } from "@/lib/types";
import { extractJson } from "@/lib/validate";
import { MalformedResponseError, ProviderUnavailableError, type AIProvider } from "./provider";

/**
 * IBM Bob provider - INTEGRATION POINT.
 *
 * Status: not connected. No IBM Bob API, SDK, endpoint or auth scheme is assumed here,
 * because none was available in this project when it was built.
 *
 * Everything around the missing piece is ready:
 *   - prompts that ask for the exact JSON shape the UI needs
 *   - JSON extraction for replies wrapped in code fences or extra prose
 *   - validation happens afterwards in the API routes (lib/validate.ts)
 *
 * To connect IBM Bob, implement `askBob()` below using whatever access method
 * IBM Bob gives you (its documentation, CLI, or an API key from the hackathon).
 * Keep credentials in environment variables (server-side only), never in client code.
 * Then run with AI_PROVIDER=bob.
 */
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
 * TODO(connect IBM Bob): send `prompt` to IBM Bob and return its reply as plain text.
 * Throw ProviderUnavailableError if Bob cannot be reached or is not configured.
 */
async function askBob(prompt: string): Promise<string> {
  void prompt;
  throw new ProviderUnavailableError(
    "IBM Bob is not connected yet. Implement askBob() in lib/ai/bob.ts, or run with AI_PROVIDER=mock.",
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

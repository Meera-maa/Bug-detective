import type { InvestigationInput, InvestigationResult } from "@/lib/types";
import type { AIProvider } from "../provider";
import { analyze } from "./analyzer";
import { buildTest } from "./tests";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Offline stand-in for IBM Bob. Same interface, no credentials.
 * It is a rule-based analyzer (see analyzer.ts), not a language model, and the UI labels it as such.
 */
export class MockProvider implements AIProvider {
  readonly name = "Built-in analyzer (offline)";

  async investigate(input: InvestigationInput): Promise<unknown> {
    // A short pause so the loading state is visible. Set MOCK_DELAY_MS=0 to disable.
    await sleep(Number(process.env.MOCK_DELAY_MS ?? 700));
    return analyze(input).result;
  }

  async generateTest(input: InvestigationInput, result: InvestigationResult): Promise<unknown> {
    await sleep(Number(process.env.MOCK_DELAY_MS ?? 700) / 2);
    // The analysis is deterministic, so re-running it recovers the plan the fix was built from.
    return buildTest(input, result, analyze(input).plan);
  }
}

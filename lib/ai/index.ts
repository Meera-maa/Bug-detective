import type { AIProvider } from "./provider";
import { IbmBobProvider } from "./bob";
import { MockProvider } from "./mock";

/**
 * The only place that decides which AI backend is used.
 *
 * ARCHITECTURE NOTE — IBM Bob vs. the mock provider
 * --------------------------------------------------
 * IBM Bob 2.0 is the AI *development agent* used to build this application.
 * It is not a callable runtime API. The working analysis flow for the demo is
 * the MockProvider (lib/ai/mock/), which was designed and tested with Bob's help.
 *
 * AI_PROVIDER=mock   (default) Built-in offline analyzer — this is the demo provider.
 * AI_PROVIDER=bob    Reserved slot for a future callable IBM AI API (see lib/ai/bob.ts).
 *                    Not functional; selecting it throws ProviderUnavailableError.
 */
export function getProvider(): AIProvider {
  const choice = (process.env.AI_PROVIDER ?? "mock").toLowerCase();
  if (choice === "bob") return new IbmBobProvider();
  return new MockProvider();
}

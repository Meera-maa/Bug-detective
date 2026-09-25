import type { AIProvider } from "./provider";
import { IbmBobProvider } from "./bob";
import { MockProvider } from "./mock";

/**
 * The only place that decides which AI backend is used.
 *
 *   AI_PROVIDER=mock   (default) built-in offline analyzer, no credentials needed
 *   AI_PROVIDER=bob    IBM Bob (see lib/ai/bob.ts - needs to be connected first)
 */
export function getProvider(): AIProvider {
  const choice = (process.env.AI_PROVIDER ?? "mock").toLowerCase();
  if (choice === "bob") return new IbmBobProvider();
  return new MockProvider();
}

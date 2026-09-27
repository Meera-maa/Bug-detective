# IBM Bob 2.0 — Contributions Log

This file lists **everything IBM Bob 2.0 helped build** in this project, as the hackathon requires.
Keep it honest: only list work Bob actually did in a Bob task session.

## Not made with Bob (baseline)

The app as prepared **before** the hackathon (git tag `pre-hackathon-baseline`): Next.js UI, API routes,
rule-based analyzer, test runner, three demo bugs. Bob did not help create any of it.

## Bob tasks

Copy one block per Bob task. Fill it in right after the task, while you still remember.

### Task 1 — Clarify IBM Bob role and fix AI provider architecture

- **Date / time:** 2025 (hackathon)
- **Goal:** Resolve the misleading "IBM Bob runtime API" stub, establish that IBM Bob is the development agent and MockProvider is the real working analysis flow, and update all docs/comments to be accurate.
- **Prompt (short):** "Inspect the project and fix the IBM Bob integration. Do not invent an API endpoint or credentials. Determine how IBM Bob 2.0 is supposed to be used and keep the app working with the supported AI provider."
- **Files created or changed by Bob:**
  - `lib/ai/bob.ts` — replaced "TODO connect IBM Bob" comment with a clear architectural explanation; renamed `prompt` param to `_prompt` to silence unused-var lint; updated the error message in `askBob()` to accurately describe Bob's role
  - `lib/ai/index.ts` — updated module-level comment to clearly distinguish IBM Bob (dev agent) from MockProvider (runtime demo provider)
  - `.env.example` — removed misleading `BOB_API_KEY` placeholder; rewrote comments to accurately describe both provider options
  - `BOB_CONTRIBUTIONS.md` — this entry
- **What I reviewed or changed by hand:** _none — changes applied directly by Bob_
- **Result:** Tests pass unchanged; mock provider is the confirmed demo path; `AI_PROVIDER=bob` remains as a reserved future slot; no invented credentials
- **Bob task session summary screenshot:** _(add screenshot here)_

### Task 2 — _title_

_(same fields as above)_

## Summary table

## IBM Bob 2.0 – Development Tasks

| # | Task                                                                                                                                                                                                                          | Files Touched                                      | Screenshot                    |
| - | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------- |
| 1 | **Project Review:** Reviewed the project and identified key risks. The README was missing a live demo link and screenshots, and the test runner only supported JavaScript while Python and Java were advertised as supported. | None — read-only review                            | <img width="467" height="248" alt="image" src="https://github.com/user-attachments/assets/a725262a-93f3-4f4b-8c03-3397bc496c89" />|
| 2 | **Bob Integration:** Asked Bob to inspect and fix the IBM Bob integration. Checked how Bob 2.0 should be used, reviewed `AI_PROVIDER` and `lib/ai/bob.ts`, and avoided inventing API endpoints or credentials.                | `lib/ai/bob.ts`                                    | `<img width="470" height="246" alt="image" src="https://github.com/user-attachments/assets/2beaf68d-f15a-4cf8-a01a-e6a34ba8ca63" />
` |
| 3 | **Bug Analyzer:** Expanded the bug analyzer beyond the three pre-built demos while keeping the existing demo behavior and tests working. **5/5 subtasks completed.**                                                          | `lib/ai/mock/analyzer.ts`<br>`tests/demos.test.ts` | <img width="465" height="262" alt="image" src="https://github.com/user-attachments/assets/c0cb962b-fe3f-4d2f-9756-61a933754def" />|


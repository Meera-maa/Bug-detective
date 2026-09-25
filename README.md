# 🕵️ Bug Detective

**Investigate. Fix. Verify.**

[![CI](https://github.com/Meera-maa/bug-detective/actions/workflows/ci.yml/badge.svg)](https://github.com/Meera-maa/bug-detective/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An AI-assisted debugging workflow for developers. Paste an error message, an optional stack trace and the relevant code. Bug Detective returns a **root cause, evidence quoted from your code, a confidence level, a suggested fix and a regression test**, then runs that test against the original and the fixed code in your browser.

> 🏁 Built for the **IBM Bob 2.0 hackathon** (workflow: **debugging**). What IBM Bob helped build, with session screenshots, is documented in **[BOB_CONTRIBUTIONS.md](BOB_CONTRIBUTIONS.md)**.

<!-- Live demo: add your deployed link here, e.g. **[Live demo →](https://your-app.vercel.app)** -->

<!-- Screenshots: save images in docs/screenshots/ and uncomment:
![Home](docs/screenshots/home.png)
![Investigation](docs/screenshots/investigation.png)
![Test result](docs/screenshots/test.png)
-->

## The problem

Debugging is where developers lose the most time, and beginners lose the most of all:

```
Error → search Google → read several pages → try random fixes → still broken
```

Bug Detective turns that into one guided path:

```
Error → Investigate → Root cause + Evidence → Fix → Regression test → Verify
```

**Measured impact** (to be filled with real measurements from the sample bugs, not estimates):

| Bug | Usual way (search + trial and error) | With Bug Detective |
|---|---|---|
| 1. Login TypeError | _to be measured_ | _to be measured_ |
| 2. API response mismatch | _to be measured_ | _to be measured_ |
| 3. Empty input crash | _to be measured_ | _to be measured_ |

## Features

- Structured input: error message, optional stack trace, code, language, with validation and clear empty/loading/error states
- **Root cause with evidence** quoted from the pasted code. Evidence is never invented.
- Confidence level (Low / Medium / High). Unrecognized bugs report Low confidence instead of guessing.
- Suggested fix shown as a before/after diff
- **Regression test generation** with a copy button
- **Run Test** executes the test in a sandboxed Web Worker and shows PASS ✓ / FAIL ✕ on the original and the fixed code. Only real results are shown, never fake ones.
- Recent investigations saved in `localStorage` (no database, no login)
- Three one-click demo bugs

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · Web Workers · Vitest · ESLint · GitHub Actions

## Run it

Requires Node.js 20.9 or newer.

```bash
npm install
npm run dev                  # http://localhost:3000
npm run build && npm start   # production
npm test                     # demo + robustness tests
npm run typecheck && npm run lint
```

No credentials are needed. The app uses a built-in, rule-based analyzer (`AI_PROVIDER=mock`, the default).

## How it works

```
Next.js UI → /api/investigate → getProvider() → analyzer
                                   ↓
                        validate (lib/validate.ts) → UI
```

- `lib/ai/provider.ts`: the `AIProvider` interface every analyzer implements
- `lib/ai/index.ts`: the single place that picks the analyzer
- `lib/ai/mock/`: the built-in offline analyzer
- `lib/ai/bob.ts`: an **unconnected** slot for an external AI provider. It is not used by the app today.
- `lib/validate.ts`: every analyzer reply is validated before it reaches the UI
- `lib/runner/`: the sandboxed Web Worker that runs JavaScript tests
- `tests/`: automated tests for the demos and for malformed or empty input

## Demo bugs (one click on the home page)

1. **Login TypeError**: `data.user` may be undefined, then `user.name` is read.
2. **API response mismatch**: the API returns `profile.name`, the code reads `data.user.name`.
3. **Empty input crash**: `getInitials("")` never validates empty input.

Each goes Error → Root cause → Evidence → Fix → Test → Run (fails on the original code, passes on the fix).

## Honest limitations

- The analyzer is **rule-based**, not a language model. It is strong on the demo bugs and common JavaScript/TypeScript errors.
- Python and Java errors are not analyzed yet. The app says so.
- **Run Test** executes JavaScript only. Other languages get a "run locally" state.

## Roadmap

- Sample project with planted bugs, so the workflow runs end to end on a real codebase
- More bug types, including Python
- A language-model-backed analyzer behind the same `AIProvider` interface

## Author

Built by [Meera-maa](https://github.com/Meera-maa).

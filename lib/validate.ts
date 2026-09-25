import {
  LANGUAGES,
  type Confidence,
  type GeneratedTest,
  type InvestigationInput,
  type InvestigationResult,
  type Language,
} from "./types";

export const LIMITS = {
  error: 5_000,
  stackTrace: 10_000,
  code: 30_000,
  expectedResult: 500,
  actualResult: 500,
} as const;

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates what the user typed. Used on the client (fast feedback) and on the server (trust nothing). */
export function parseInvestigationInput(raw: unknown): Parsed<InvestigationInput> {
  if (!isRecord(raw)) return { ok: false, message: "Request body must be a JSON object." };

  const error = typeof raw.error === "string" ? raw.error.trim() : "";
  const code = typeof raw.code === "string" ? raw.code.replace(/\s+$/, "") : "";
  const stackTrace = typeof raw.stackTrace === "string" ? raw.stackTrace.trim() : "";
  const expectedResult = typeof raw.expectedResult === "string" ? raw.expectedResult.trim() : "";
  const actualResult = typeof raw.actualResult === "string" ? raw.actualResult.trim() : "";
  const language = raw.language;

  if (!error) return { ok: false, message: "Describe the error first. Paste the error message you are seeing." };
  if (!code.trim()) return { ok: false, message: "Paste the code where the error happens." };
  if (error.length > LIMITS.error) return { ok: false, message: `The error message is too long (max ${LIMITS.error} characters).` };
  if (stackTrace.length > LIMITS.stackTrace) return { ok: false, message: `The stack trace is too long (max ${LIMITS.stackTrace} characters).` };
  if (code.length > LIMITS.code) return { ok: false, message: `The code is too long (max ${LIMITS.code} characters). Paste only the relevant part.` };
  if (expectedResult.length > LIMITS.expectedResult) return { ok: false, message: `The expected result is too long (max ${LIMITS.expectedResult} characters).` };
  if (actualResult.length > LIMITS.actualResult) return { ok: false, message: `The actual result is too long (max ${LIMITS.actualResult} characters).` };
  if (typeof language !== "string" || !(LANGUAGES as readonly string[]).includes(language)) {
    return { ok: false, message: "Choose a supported language." };
  }

  return {
    ok: true,
    value: {
      error,
      code,
      language: language as Language,
      ...(stackTrace ? { stackTrace } : {}),
      ...(expectedResult ? { expectedResult } : {}),
      ...(actualResult ? { actualResult } : {}),
    },
  };
}

const CONFIDENCES: readonly Confidence[] = ["Low", "Medium", "High"];

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Validates whatever an AI provider hands back. Never trust it. */
export function parseInvestigationResult(raw: unknown): Parsed<InvestigationResult> {
  if (!isRecord(raw)) return { ok: false, message: "The AI response was not an object." };

  const { problem, rootCause, evidence, confidence, suggestedFix, testSuggestion, fixedCode } = raw;

  if (!nonEmptyString(problem)) return { ok: false, message: "Missing 'problem'." };
  if (!nonEmptyString(rootCause)) return { ok: false, message: "Missing 'rootCause'." };
  if (!Array.isArray(evidence) || evidence.length === 0 || !evidence.every(nonEmptyString)) {
    return { ok: false, message: "'evidence' must be a non-empty list of strings." };
  }
  if (typeof confidence !== "string" || !CONFIDENCES.includes(confidence as Confidence)) {
    return { ok: false, message: "'confidence' must be Low, Medium or High." };
  }
  if (!nonEmptyString(suggestedFix)) return { ok: false, message: "Missing 'suggestedFix'." };
  if (!nonEmptyString(testSuggestion)) return { ok: false, message: "Missing 'testSuggestion'." };
  if (fixedCode !== undefined && typeof fixedCode !== "string") {
    return { ok: false, message: "'fixedCode' must be a string when present." };
  }

  return {
    ok: true,
    value: {
      problem: problem.trim(),
      rootCause: rootCause.trim(),
      evidence: evidence.map((e) => e.trim()),
      confidence: confidence as Confidence,
      suggestedFix: suggestedFix.trim(),
      testSuggestion: testSuggestion.trim(),
      ...(typeof fixedCode === "string" && fixedCode.trim() ? { fixedCode } : {}),
    },
  };
}

export function parseGeneratedTest(raw: unknown): Parsed<GeneratedTest> {
  if (!isRecord(raw)) return { ok: false, message: "The AI response was not an object." };
  const { framework, filename, code, covers } = raw;
  if (!nonEmptyString(framework)) return { ok: false, message: "Missing 'framework'." };
  if (!nonEmptyString(filename)) return { ok: false, message: "Missing 'filename'." };
  if (!nonEmptyString(code)) return { ok: false, message: "Missing test 'code'." };
  if (!Array.isArray(covers) || !covers.every(nonEmptyString)) {
    return { ok: false, message: "'covers' must be a list of strings." };
  }
  return { ok: true, value: { framework, filename, code, covers } };
}

/** Pulls a JSON object out of text that may be wrapped in ```json fences or prose. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```json|```/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object found in the AI response.");
  return JSON.parse(cleaned.slice(start, end + 1));
}

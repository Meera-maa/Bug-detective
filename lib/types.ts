// Shared types used by both the UI and the server.

export const LANGUAGES = [
  "JavaScript",
  "TypeScript",
  "Python",
  "Java",
  "Other",
] as const;
export type Language = (typeof LANGUAGES)[number];

/** What the developer types into the form. */
export type InvestigationInput = {
  error: string;
  stackTrace?: string;
  code: string;
  language: Language;
  /** Optional: the value the user expected the code to produce (for logic bugs). */
  expectedResult?: string;
  /** Optional: the value the code actually produced (for logic bugs). */
  actualResult?: string;
};

export type Confidence = "Low" | "Medium" | "High";

/** What the AI provider must return for an investigation. */
export type InvestigationResult = {
  problem: string;
  rootCause: string;
  evidence: string[];
  confidence: Confidence;
  suggestedFix: string;
  testSuggestion: string;
  /** Full corrected version of the pasted code, when the provider can produce one. */
  fixedCode?: string;
};

/** A generated regression test. */
export type GeneratedTest = {
  framework: string;
  filename: string;
  code: string;
  /** Short plain-language list of what the test covers. */
  covers: string[];
};

/** One saved investigation (kept in localStorage). */
export type InvestigationRecord = {
  id: string;
  createdAt: string;
  title: string;
  severity: Severity;
  provider: string;
  input: InvestigationInput;
  result: InvestigationResult;
  test?: GeneratedTest;
};

export type Severity = "red" | "orange" | "yellow";

export type ApiErrorCode =
  | "INVALID_INPUT"
  | "PROVIDER_UNAVAILABLE"
  | "MALFORMED_RESPONSE"
  | "TIMEOUT"
  | "INTERNAL";

export type ApiError = { code: ApiErrorCode; message: string };

import type { Confidence, InvestigationInput, InvestigationResult } from "@/lib/types";
import { escapeRegExp, findJsonObject, firstLine } from "./text";

/**
 * Built-in offline analyzer used by the mock provider.
 *
 * It is a rule-based analyzer, NOT a language model. It reads the pasted error, stack trace
 * and code, and only reports evidence it can actually point to in that input.
 * When it does not recognise a pattern it says so and returns low confidence.
 *
 * Recognised patterns (JavaScript / TypeScript):
 *   1. "Cannot read properties of undefined" on a value that was never checked
 *   2. The same error caused by an API response with a different shape than the code expects
 *   3. Empty input (empty string / empty array) that is indexed with [0]
 *   4. ReferenceError: x is not defined
 *   5. SyntaxError — including the specific case of a server returning HTML instead of JSON
 *   6. RangeError: Maximum call stack size exceeded (infinite recursion)
 *   7. RangeError: Invalid array length (negative or non-integer size)
 *   8. "X is not a function" / "X is not iterable" — including Array methods on objects
 *   9. Missing return — function silently returns undefined and caller reads a property
 *  10. async/await forgotten — Promise used as a plain value
 *  11. Network / fetch failure (Failed to fetch, CORS, net::ERR_*)
 *  12. Unhandled promise rejection (missing .catch / try-catch)
 *  13. Logic / wrong-operator error (= vs ===, off-by-one, NaN comparison)
 *
 * Python patterns (rule-based, partial):
 *  P1. IndexError   P2. KeyError    P3. TypeError (wrong type)
 *  P4. NameError    P5. AttributeError  P6. ZeroDivisionError  P7. ValueError
 *
 * Java patterns (rule-based, partial):
 *  J1. NullPointerException       J2. ArrayIndexOutOfBoundsException
 *  J3. NumberFormatException      J4. ArithmeticException (/ by zero)
 *  J5. ClassCastException
 *
 * Fallback (analyzeGeneric): runs for everything else. It reasons from the error type,
 * stack trace, and code structure to provide the most specific diagnosis possible from
 * the available evidence. It never fabricates a root cause it cannot point to.
 */

// ---------------------------------------------------------------------------
// Types shared with the test generator
// ---------------------------------------------------------------------------

export type TestPlan =
  | { kind: "null-guard"; fnName: string; rootParam: string; path: string[]; prop: string; returnsProp: boolean }
  | {
      kind: "contract-mismatch";
      fnName: string;
      rootParam: string;
      expectedKey: string;
      actualKey: string;
      prop: string;
      sampleValue: unknown;
    }
  | { kind: "empty-input"; fnName: string; param: string; fallback: string; template: "initials" | "generic" }
  | { kind: "empty-collection"; fnName: string; param: string; prop: string; returnsProp: boolean }
  | { kind: "not-a-function"; fnName?: string; callee: string }
  | { kind: "stack-overflow"; fnName: string }
  | { kind: "generic"; fnName?: string };

export type Analysis = { result: InvestigationResult; plan: TestPlan };

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

type CodeLine = { n: number; text: string };

type ParsedError = { nullish: "undefined" | "null"; prop: string };
type StackFrame = { fn?: string; file: string; line: number; col: number };
type FnContext = { name: string; params: string[]; signatureLine: number; signatureEndsWithBrace: boolean };

function parseTypeError(text: string): ParsedError | null {
  let m = /Cannot read propert(?:y|ies) of (undefined|null) \(reading '([^']+)'\)/i.exec(text);
  if (m) return { nullish: m[1].toLowerCase() as ParsedError["nullish"], prop: m[2] };
  m = /Cannot read property '([^']+)' of (undefined|null)/i.exec(text);
  if (m) return { nullish: m[2].toLowerCase() as ParsedError["nullish"], prop: m[1] };
  m = /can't access property "([^"]+)", [\w$.]+ is (undefined|null)/i.exec(text);
  if (m) return { nullish: m[2].toLowerCase() as ParsedError["nullish"], prop: m[1] };
  return null;
}

function parseStackFrame(text: string): StackFrame | null {
  const m = /\bat\s+(?:async\s+)?(?:([\w$.<>]+)\s+)?\(?([^\s()]+?):(\d+):(\d+)\)?/.exec(text);
  if (!m) return null;
  return { fn: m[1], file: m[2], line: Number(m[3]), col: Number(m[4]) };
}

function toLines(code: string): CodeLine[] {
  return code.split("\n").map((text, i) => ({ n: i + 1, text }));
}

function paramNames(raw: string): string[] {
  return raw
    .split(",")
    .map((p) => p.trim().split(/[=:]/)[0].trim())
    .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p));
}

const FN_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?\(([^)]*)\)\s*(?::[^={]+)?(?:=>|\{)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?([A-Za-z_$][\w$]*)\s*=>/,
];

function findEnclosingFunction(lines: CodeLine[], failingLine: number): FnContext | null {
  for (let i = failingLine - 1; i >= 0; i--) {
    for (const pattern of FN_PATTERNS) {
      const m = pattern.exec(lines[i].text);
      if (m) {
        return {
          name: m[1],
          params: paramNames(m[2]),
          signatureLine: lines[i].n,
          signatureEndsWithBrace: /\{\s*$/.test(lines[i].text),
        };
      }
    }
  }
  return null;
}

function indentOf(text: string): string {
  return /^\s*/.exec(text)?.[0] ?? "";
}

function truncate(s: string, max = 70): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function insertAfterLine(lines: string[], lineNumber: number, insert: string[]): string[] {
  return [...lines.slice(0, lineNumber), ...insert, ...lines.slice(lineNumber)];
}

function hasGuardBetween(lines: CodeLine[], from: number, to: number, name: string): boolean {
  const n = escapeRegExp(name);
  const guard = new RegExp(`(?:if\\s*\\(\\s*!?\\s*${n}\\b|\\b${n}\\s*(?:&&|\\?\\?|\\|\\|)|\\b${n}\\?\\.|typeof\\s+${n}\\b)`);
  return lines.filter((l) => l.n >= from && l.n < to).some((l) => guard.test(l.text));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function analyze(input: InvestigationInput): Analysis {
  const isJsLike = input.language === "JavaScript" || input.language === "TypeScript";
  const combined = `${input.error}\n${input.stackTrace ?? ""}`;

  if (input.language === "Python") {
    const found = analyzePython(input, combined);
    if (found) return found;
    return analyzeGeneric(input, combined, false);
  }

  if (input.language === "Java") {
    const found = analyzeJava(input, combined);
    if (found) return found;
    return analyzeGeneric(input, combined, false);
  }

  if (isJsLike) {
    const typeError = parseTypeError(combined);
    if (typeError) {
      const found = analyzeNullishRead(input, combined, typeError);
      if (found) return found;
    }
    const ref = /ReferenceError:\s*([A-Za-z_$][\w$]*) is not defined/.exec(combined);
    if (ref) {
      const found = analyzeReferenceError(input, combined, ref[1]);
      if (found) return found;
    }
    // Patterns 5-13: additional JS/TS patterns
    const synFound = analyzeSyntaxError(input, combined);
    if (synFound) return synFound;
    const stackFound = analyzeStackOverflow(input, combined);
    if (stackFound) return stackFound;
    const rangeFound = analyzeInvalidArrayLength(input, combined);
    if (rangeFound) return rangeFound;
    // UnhandledPromiseRejection is a process-level event — check it before the
    // async/await pattern so a missing .catch() gets the right diagnosis.
    const rejectionFound = analyzeUnhandledRejection(input, combined);
    if (rejectionFound) return rejectionFound;
    // async/await must run before not-a-function: ".then is not a function" matches both,
    // but the async pattern gives a more specific diagnosis.
    const asyncFound = analyzeAsyncAwaitForgotten(input, combined);
    if (asyncFound) return asyncFound;
    const notFnFound = analyzeNotAFunction(input, combined);
    if (notFnFound) return notFnFound;
    const returnFound = analyzeMissingReturn(input, combined);
    if (returnFound) return returnFound;
    const networkFound = analyzeNetworkFailure(input, combined);
    if (networkFound) return networkFound;
    const logicFound = analyzeLogicError(input, combined);
    if (logicFound) return logicFound;
  }
  return analyzeGeneric(input, combined, isJsLike);
}

// ---------------------------------------------------------------------------
// Pattern 1-3: reading a property of undefined / null
// ---------------------------------------------------------------------------

function analyzeNullishRead(input: InvestigationInput, combined: string, err: ParsedError): Analysis | null {
  const lines = toLines(input.code);
  const frame = parseStackFrame(input.stackTrace ?? combined);
  const propRe = new RegExp(`\\.\\s*${escapeRegExp(err.prop)}\\b`);

  // Which line failed? Prefer the stack trace line, but only when it really contains the property.
  const stackLine = frame ? lines.find((l) => l.n === frame.line && propRe.test(l.text)) : undefined;
  const failing = stackLine ?? lines.find((l) => propRe.test(l.text));
  if (!failing) return null;
  const stackConfirms = Boolean(stackLine);

  // Which expression was undefined? The text right before ".prop" on that line.
  const receiverRe = new RegExp(
    `((?:[A-Za-z_$][\\w$]*)(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]]*\\])*)\\.${escapeRegExp(err.prop)}\\b`,
  );
  const receiver = receiverRe.exec(failing.text)?.[1];
  if (!receiver) return null;

  const fn = findEnclosingFunction(lines, failing.n);
  const stackEvidence = frame
    ? `The stack trace points to ${frame.fn ? `\`${frame.fn}\` at ` : ""}\`${frame.file}:${frame.line}:${frame.col}\`${
        stackConfirms ? ", which matches the pasted code." : ", but that line number does not match the pasted snippet, so the line was found by searching the code."
      }`
    : null;
  const errorEvidence = `The error says \`${err.prop}\` was read from \`${err.nullish}\`, so something on the left of \`.${err.prop}\` had no value at runtime.`;

  // ---- Pattern 3: element access such as part[0] or items[0] -------------------------------
  const element = /^([A-Za-z_$][\w$]*)\[(\d+)\]$/.exec(receiver);
  if (element) {
    return analyzeElementAccess({ input, lines, failing, receiver, base: element[1], err, fn, stackEvidence, errorEvidence, stackConfirms });
  }

  // ---- Chain such as data.user.name --------------------------------------------------------
  if (receiver.includes(".")) {
    return analyzeChain({ input, lines, failing, receiver, err, fn, stackEvidence, errorEvidence, combined, stackConfirms });
  }

  // ---- Simple variable such as user.name ---------------------------------------------------
  return analyzeVariable({ input, lines, failing, receiver, err, fn, stackEvidence, errorEvidence, stackConfirms });
}

type Ctx = {
  input: InvestigationInput;
  lines: CodeLine[];
  failing: CodeLine;
  receiver: string;
  err: ParsedError;
  fn: FnContext | null;
  stackEvidence: string | null;
  errorEvidence: string;
  stackConfirms: boolean;
};

const returnsDirectly = (text: string, receiver: string, prop: string) =>
  new RegExp(`^\\s*return\\s+${escapeRegExp(receiver)}\\.${escapeRegExp(prop)}\\s*;?\\s*$`).test(text);

function analyzeVariable(ctx: Ctx): Analysis | null {
  const { input, lines, failing, receiver, err, fn, stackEvidence, errorEvidence, stackConfirms } = ctx;
  const codeLines = input.code.split("\n");
  const fallback = "null";

  // Where did the variable come from?
  const declRe = new RegExp(`^\\s*(?:const|let|var)\\s+${escapeRegExp(receiver)}\\s*(?::[^=]+)?=\\s*([^;]+?)\\s*;?\\s*$`);
  const decl = [...lines].reverse().find((l) => l.n < failing.n && declRe.test(l.text));
  const isParam = fn?.params.includes(receiver) ?? false;
  if (!decl && !isParam) return null;

  const sourceExpr = decl ? (declRe.exec(decl.text)?.[1] ?? "") : receiver;
  const from = decl?.n ?? fn?.signatureLine ?? 1;
  const guarded = hasGuardBetween(lines, from, failing.n, receiver);
  const direct = returnsDirectly(failing.text, receiver, err.prop);

  const evidence = [
    errorEvidence,
    `Line ${failing.n} (\`${truncate(failing.text)}\`) reads \`${receiver}.${err.prop}\` directly.`,
    decl
      ? `\`${receiver}\` is assigned from \`${truncate(sourceExpr, 50)}\` on line ${decl.n}, so it is only as reliable as that value.`
      : `\`${receiver}\` is a parameter of \`${fn?.name}\`, so callers decide whether it has a value.`,
    guarded
      ? `A check involving \`${receiver}\` exists before line ${failing.n}, but it does not stop this path (worth double-checking).`
      : `No check for a missing \`${receiver}\` appears between ${decl ? `line ${decl.n}` : "the function start"} and line ${failing.n}.`,
  ];
  if (stackEvidence) evidence.push(stackEvidence);

  // Build the fixed code (only when we can do it safely).
  let fixedCode: string | undefined;
  if (fn && (decl || fn.signatureEndsWithBrace) && !guarded) {
    let out = [...codeLines];
    if (decl) {
      const chained = sourceExpr.includes("?.") ? sourceExpr : sourceExpr.replace(/\./g, "?.");
      out[decl.n - 1] = codeLines[decl.n - 1].replace(sourceExpr, chained);
      const ind = indentOf(codeLines[decl.n - 1]);
      out = insertAfterLine(out, decl.n, [`${ind}if (!${receiver}) {`, `${ind}  return ${fallback};`, `${ind}}`]);
    } else {
      const ind = `${indentOf(codeLines[fn.signatureLine - 1])}  `;
      out = insertAfterLine(out, fn.signatureLine, [`${ind}if (!${receiver}) {`, `${ind}  return ${fallback};`, `${ind}}`, ""]);
    }
    fixedCode = out.join("\n");
  }

  const rootOfSource = sourceExpr.split(/[.?[]+/)[0];
  const rootParam = decl ? (fn?.params[0] === rootOfSource ? rootOfSource : undefined) : receiver;
  const path = decl ? sourceExpr.replace(/\?\./g, ".").split(".").slice(1) : [];
  const plan: TestPlan =
    fn && rootParam && fn.params[0] === rootParam && /^[\w$.?]+$/.test(sourceExpr)
      ? { kind: "null-guard", fnName: fn.name, rootParam, path, prop: err.prop, returnsProp: direct }
      : { kind: "generic", fnName: fn?.name };

  const confidence: Confidence = !guarded && (stackConfirms || decl) ? (stackConfirms && decl ? "High" : "Medium") : "Low";

  return {
    plan,
    result: {
      problem: `\`${receiver}.${err.prop}\` is read while \`${receiver}\` is ${err.nullish}${fn ? `, inside \`${fn.name}\`` : ""}.`,
      rootCause: decl
        ? `\`${receiver}\` comes from \`${truncate(sourceExpr, 50)}\` (line ${decl.n}) and is used on line ${failing.n} without checking that it exists. When \`${sourceExpr}\` is missing, \`${receiver}\` is ${err.nullish} and reading \`.${err.prop}\` throws.`
        : `\`${receiver}\` is a function parameter that is used on line ${failing.n} without checking that it exists. When a caller passes ${err.nullish}, reading \`.${err.prop}\` throws.`,
      evidence,
      confidence,
      suggestedFix: fixedCode
        ? [
            `Check that \`${receiver}\` exists before using it, and return early when it does not.${decl ? ` Also read \`${sourceExpr}\` with optional chaining (\`${sourceExpr.replace(/\./g, "?.")}\`) so a missing parent object does not throw either.` : ""}`,
            `Why it works: the property is only read once \`${receiver}\` is known to have a value.`,
            `Assumption: returning \`${fallback}\` when \`${receiver}\` is missing is acceptable to the callers of \`${fn?.name ?? "this code"}\`. If they need a default value or an error instead, change the early return.`,
          ].join("\n\n")
        : `Check that \`${receiver}\` exists before reading \`.${err.prop}\` (for example \`${receiver}?.${err.prop}\`), and decide what the code should do when it is missing. The analyzer could not safely rewrite this code automatically.`,
      testSuggestion: `Cover: ${receiver} present (normal case), ${receiver} missing (the bug), and undefined input, then assert the code no longer throws.`,
      ...(fixedCode ? { fixedCode } : {}),
    },
  };
}

function analyzeChain(ctx: Ctx & { combined: string }): Analysis | null {
  const { input, lines, failing, receiver, err, fn, stackEvidence, errorEvidence, combined, stackConfirms } = ctx;
  const codeLines = input.code.split("\n");
  const segs = receiver.split(".");
  const root = segs[0];
  const direct = returnsDirectly(failing.text, receiver, err.prop);

  // Did the developer also paste a JSON response? Then we can compare its shape with what the code expects.
  const json = findJsonObject(combined);
  const expectedKey = segs[1];
  if (json && segs.length === 2 && !(expectedKey in json)) {
    const actualKey = Object.keys(json).find((k) => {
      const v = json[k];
      return typeof v === "object" && v !== null && !Array.isArray(v) && err.prop in (v as Record<string, unknown>);
    });
    if (actualKey && fn) {
      const sampleValue = (json[actualKey] as Record<string, unknown>)[err.prop];
      const keys = Object.keys(json).map((k) => `\`${k}\``).join(", ");
      const newExpr = `${root}?.${actualKey}?.${err.prop}`;
      const isReturn = /^\s*return\s+[^;]+;?\s*$/.test(failing.text) && direct;
      const fixedLine = failing.text.replace(`${receiver}.${err.prop}`, isReturn ? `${newExpr} ?? null` : newExpr);
      const fixedCode = codeLines.map((l, i) => (i === failing.n - 1 ? fixedLine : l)).join("\n");

      const evidence = [
        errorEvidence,
        `Line ${failing.n} (\`${truncate(failing.text)}\`) reads \`${receiver}.${err.prop}\`, so the code expects a top-level \`${expectedKey}\` object.`,
        `The pasted response has the top-level key${Object.keys(json).length > 1 ? "s" : ""} ${keys} and no \`${expectedKey}\`, so \`${receiver}\` is undefined.`,
        `\`${actualKey}\` contains \`${err.prop}: ${JSON.stringify(sampleValue)}\`, which looks like the value the code is trying to read.`,
      ];
      if (stackEvidence) evidence.push(stackEvidence);
      evidence.push(`Assumption: the pasted JSON is the value stored in \`${root}\`.`);

      return {
        plan: { kind: "contract-mismatch", fnName: fn.name, rootParam: root, expectedKey, actualKey, prop: err.prop, sampleValue },
        result: {
          problem: `The code reads \`${receiver}.${err.prop}\`, but the API response has no \`${expectedKey}\` field.`,
          rootCause: `The code and the API disagree about the response shape. The code expects \`${expectedKey}.${err.prop}\`, while the API returns \`${actualKey}.${err.prop}\`. Because \`${receiver}\` is undefined, reading \`.${err.prop}\` throws.`,
          evidence,
          confidence: "High",
          suggestedFix: [
            `Read the field from \`${actualKey}\` instead of \`${expectedKey}\`, and use optional chaining so a missing \`${actualKey}\` object returns \`null\` instead of throwing.`,
            `Why it works: the code now follows the shape the API actually returns.`,
            `Assumption: \`${actualKey}\` is the intended, stable API contract. If the API sometimes returns \`${expectedKey}\` too (for example across versions), support both instead of replacing one. Also check any other code that reads \`${receiver}\`.`,
          ].join("\n\n"),
          testSuggestion: `Cover: a response shaped like the real API (\`${actualKey}.${err.prop}\`), a response with no \`${actualKey}\`, and undefined input.`,
          fixedCode,
        },
      };
    }
  }

  // No JSON to compare: treat the whole chain as possibly missing.
  const guarded = segs.some((_, i) => hasGuardBetween(lines, fn?.signatureLine ?? 1, failing.n, segs.slice(0, i + 1).join(".")));
  const newExpr = `${receiver.replace(/\./g, "?.")}?.${err.prop}`;
  const isReturn = direct;
  const fixedLine = failing.text.replace(`${receiver}.${err.prop}`, isReturn ? `${newExpr} ?? null` : newExpr);
  const fixedCode = guarded ? undefined : codeLines.map((l, i) => (i === failing.n - 1 ? fixedLine : l)).join("\n");

  const evidence = [
    errorEvidence,
    `Line ${failing.n} (\`${truncate(failing.text)}\`) reads \`${receiver}.${err.prop}\` through a chain of properties, and every link in \`${receiver}\` must exist.`,
    guarded
      ? `Some check on \`${receiver}\` exists earlier, but it does not stop this path.`
      : `No check for a missing \`${receiver}\` appears before line ${failing.n}.`,
  ];
  if (stackEvidence) evidence.push(stackEvidence);
  evidence.push(`Tip: paste the actual data (for example the API response) into the error box and the analyzer can compare its shape with \`${receiver}\`.`);

  const plan: TestPlan =
    fn && fn.params[0] === root
      ? { kind: "null-guard", fnName: fn.name, rootParam: root, path: segs.slice(1), prop: err.prop, returnsProp: direct }
      : { kind: "generic", fnName: fn?.name };

  return {
    plan,
    result: {
      problem: `\`${receiver}.${err.prop}\` throws because part of \`${receiver}\` is ${err.nullish}.`,
      rootCause: `\`${receiver}\` is read through a chain of properties without checking that each link exists. If \`${segs.slice(0, -1).join(".")}\` or \`${receiver}\` is missing at runtime, reading \`.${err.prop}\` throws. The analyzer cannot tell which link is missing without seeing the real data.`,
      evidence,
      confidence: guarded || !stackConfirms ? "Low" : "Medium",
      suggestedFix: fixedCode
        ? [
            `Use optional chaining (\`?.\`) along the whole chain so a missing link gives \`undefined\` instead of throwing, and fall back to \`null\`.`,
            `Why it works: the property is only read when every earlier link exists.`,
            `Assumption: \`null\` is an acceptable result when the data is missing. This hides the missing data, so also find out why \`${receiver}\` is absent.`,
          ].join("\n\n")
        : `Add a check for each link in \`${receiver}\` before reading \`.${err.prop}\`, and find out why the data is missing.`,
      testSuggestion: `Cover: complete data (normal case), data missing \`${segs[1]}\`, and undefined input.`,
      ...(fixedCode ? { fixedCode } : {}),
    },
  };
}

function analyzeElementAccess(
  ctx: Ctx & { base: string },
): Analysis | null {
  const { input, lines, failing, receiver, base, err, fn, stackEvidence, errorEvidence } = ctx;
  const codeLines = input.code.split("\n");
  const param = fn?.params[0];

  // Is `base` (e.g. "part") an item of an array produced by splitting a string parameter?
  const splitsParam = Boolean(param && fn && new RegExp(`\\b${escapeRegExp(param)}\\s*\\.\\s*split\\s*\\(`).test(input.code));
  const splitLine = splitsParam ? lines.find((l) => /\.split\s*\(/.test(l.text)) : undefined;

  if (fn && param && splitsParam && splitLine && base !== param) {
    const guardedAlready = hasGuardBetween(lines, fn.signatureLine, failing.n, param);
    const isStringJoin = /\.join\s*\(/.test(input.code);
    const fallback = isStringJoin ? '""' : "null";
    const initials = new RegExp(`${escapeRegExp(receiver)}\\.toUpperCase\\s*\\(`).test(failing.text) && /\.join\s*\(\s*(?:""|'')\s*\)/.test(input.code);

    const evidence = [
      errorEvidence,
      `Line ${failing.n} (\`${truncate(failing.text)}\`) reads \`${receiver}.${err.prop}\`, and \`${receiver}\` is the first character of an item from \`${param}\`.`,
      `\`${param}\` is split on line ${splitLine.n} (\`${truncate(splitLine.text)}\`). Splitting an empty string gives \`[""]\`, and \`""[0]\` is undefined.`,
      guardedAlready
        ? `Some check on \`${param}\` exists before line ${failing.n}, but it does not stop this path.`
        : `Nothing checks whether \`${param}\` is empty or missing before it is split.`,
      `Repeated separators (for example two spaces) also create empty items after a split, so the same crash can happen with non-empty input.`,
    ];
    if (stackEvidence) evidence.push(stackEvidence);

    let out = [...codeLines];
    out[splitLine.n - 1] = out[splitLine.n - 1].replace(/\.split\s*\(([^)]*)\)/, ".split($1).filter(Boolean)");
    if (fn.signatureEndsWithBrace && !guardedAlready) {
      const ind = `${indentOf(codeLines[fn.signatureLine - 1])}  `;
      out = insertAfterLine(out, fn.signatureLine, [
        `${ind}if (typeof ${param} !== "string" || ${param}.trim() === "") {`,
        `${ind}  return ${fallback};`,
        `${ind}}`,
        "",
      ]);
    }

    return {
      plan: { kind: "empty-input", fnName: fn.name, param, fallback, template: initials ? "initials" : "generic" },
      result: {
        problem: `\`${fn.name}\` crashes when \`${param}\` is empty because it reads \`${receiver}\` of an empty item.`,
        rootCause: `\`${fn.name}\` does not validate its input. An empty string becomes \`[""]\` after \`split\`, so \`${receiver}\` is undefined and \`.${err.prop}\` throws. Repeated separators cause the same problem.`,
        evidence,
        confidence: stackEvidence && ctx.stackConfirms ? "High" : "Medium",
        suggestedFix: [
          `Validate the input at the top of \`${fn.name}\`: return ${fallback} when \`${param}\` is not a string or is blank. Also add \`.filter(Boolean)\` after \`split\` so empty items are skipped.`,
          `Why it works: the loop only sees non-empty items, so \`${receiver}\` always has a value.`,
          `Assumption: returning ${fallback} for empty input is acceptable to callers. If empty input should be an error, throw a clear error instead.`,
        ].join("\n\n"),
        testSuggestion: `Cover: a normal value, an empty string (the bug), whitespace only, undefined input, and repeated separators.`,
        fixedCode: out.join("\n"),
      },
    };
  }

  // items[0].prop where items is a parameter
  if (fn && fn.params.includes(base)) {
    const guardedAlready = hasGuardBetween(lines, fn.signatureLine, failing.n, base);
    const direct = returnsDirectly(failing.text, receiver, err.prop);
    const evidence = [
      errorEvidence,
      `Line ${failing.n} (\`${truncate(failing.text)}\`) reads \`${receiver}.${err.prop}\`, which assumes \`${base}\` has at least one item.`,
      `\`${base}\` is a parameter of \`${fn.name}\`, so an empty list from the caller makes \`${receiver}\` undefined.`,
      guardedAlready ? `Some check on \`${base}\` exists earlier, but it does not stop this path.` : `No check for an empty \`${base}\` appears before line ${failing.n}.`,
    ];
    if (stackEvidence) evidence.push(stackEvidence);
    let fixedCode: string | undefined;
    if (fn.signatureEndsWithBrace && !guardedAlready) {
      const ind = `${indentOf(codeLines[fn.signatureLine - 1])}  `;
      fixedCode = insertAfterLine(codeLines, fn.signatureLine, [
        `${ind}if (!Array.isArray(${base}) || ${base}.length === 0) {`,
        `${ind}  return null;`,
        `${ind}}`,
        "",
      ]).join("\n");
    }
    return {
      plan: { kind: "empty-collection", fnName: fn.name, param: base, prop: err.prop, returnsProp: direct },
      result: {
        problem: `\`${fn.name}\` crashes when \`${base}\` is empty.`,
        rootCause: `\`${receiver}\` is undefined when \`${base}\` has no items, so reading \`.${err.prop}\` throws. The function never checks for an empty list.`,
        evidence,
        confidence: ctx.stackConfirms && !guardedAlready ? "High" : "Medium",
        suggestedFix: [
          `Return early when \`${base}\` is missing or empty, before reading \`${receiver}\`.`,
          `Why it works: the first item is only read when one exists.`,
          `Assumption: returning \`null\` for an empty list is acceptable to callers.`,
        ].join("\n\n"),
        testSuggestion: `Cover: a list with one item (normal case), an empty list (the bug), and undefined input.`,
        ...(fixedCode ? { fixedCode } : {}),
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Pattern 4: ReferenceError
// ---------------------------------------------------------------------------

function analyzeReferenceError(input: InvestigationInput, combined: string, name: string): Analysis | null {
  const lines = toLines(input.code);
  const n = escapeRegExp(name);
  const uses = lines.filter((l) => new RegExp(`\\b${n}\\b`).test(l.text));
  if (uses.length === 0) return null;
  // A line *declares* `name` if the keyword is immediately followed (with optional
  // punctuation) by the name itself — e.g. `const axios = …`, `import axios from …`,
  // `function axios(`, `import { axios }`.  A line like `const response = await axios.get()`
  // does NOT declare `axios`, so we require the keyword to be adjacent to the name.
  const declared = lines.find((l) =>
    new RegExp(`\\b(?:const|let|var|function|class)\\s+${n}\\b`).test(l.text) ||
    new RegExp(`\\bimport\\b[^;\\n]*(?:\\{[^}]*\\b${n}\\b[^}]*\\}|\\b${n}\\b)`).test(l.text) ||
    new RegExp(`\\(([^)]*\\b${n}\\b[^)]*)\\)\\s*(?:=>|\\{)`).test(l.text)
  );
  const frame = parseStackFrame(input.stackTrace ?? combined);

  const evidence = [
    `The error says \`${name}\` is not defined, so JavaScript cannot find a variable with that name in scope.`,
    `\`${name}\` is used on line ${uses[0].n} (\`${truncate(uses[0].text)}\`).`,
    declared
      ? `A line mentioning \`${name}\` exists (line ${declared.n}: \`${truncate(declared.text)}\`), so check whether it is in the same scope or spelled differently.`
      : `No declaration, import or parameter named \`${name}\` appears anywhere in the pasted code.`,
  ];
  if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}:${frame.col}\`.`);

  return {
    plan: { kind: "generic", fnName: findEnclosingFunction(lines, uses[0].n)?.name },
    result: {
      problem: `\`${name}\` is used but never defined.`,
      rootCause: declared
        ? `\`${name}\` is mentioned in the code but is likely out of scope or misspelled where it is used.`
        : `\`${name}\` is never declared, imported or passed in within the pasted code. It may be a typo, a missing import, or a variable declared in another file or scope.`,
      evidence,
      confidence: declared ? "Medium" : "High",
      suggestedFix: `Declare \`${name}\` before line ${uses[0].n}, import it, or pass it in as a parameter. If it is a typo, use the existing variable name. The analyzer does not rewrite this automatically because the correct source of \`${name}\` cannot be known from this snippet.`,
      testSuggestion: `Cover: the function running with \`${name}\` provided, and the code path that used it, asserting it no longer throws.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Fallback: evidence-driven reasoner
// ---------------------------------------------------------------------------

function analyzeGeneric(input: InvestigationInput, combined: string, isJsLike: boolean): Analysis {
  const lines = toLines(input.code);
  const headline = firstLine(input.error);
  const frame = parseStackFrame(input.stackTrace ?? combined);
  const kind = /^\s*([A-Za-z]*(?:Error|Exception))\b/.exec(headline)?.[1];
  const status = /\b([45]\d{2})\b/.exec(headline)?.[1];
  const stackLine = frame ? lines.find((l) => l.n === frame.line) : undefined;

  // ── Collect evidence from the actual input ─────────────────────────────────
  const evidence: string[] = [`The error message reads: \`${truncate(headline, 90)}\`.`];
  if (kind) evidence.push(`The error type is \`${kind}\`.`);
  if (status) {
    evidence.push(`The status code \`${status}\` was reported${status.startsWith("5") ? ", which usually means the failure happened on the server, not in the calling code" : ", which usually means the request itself was rejected"}.`);
  }
  if (frame) {
    evidence.push(`The stack trace points to \`${frame.file}:${frame.line}:${frame.col}\`${frame.fn ? ` in \`${frame.fn}\`` : ""}.`);
  }
  if (stackLine) {
    evidence.push(`Line ${stackLine.n} in the pasted code reads: \`${truncate(stackLine.text)}\`.`);
  }

  // Quote code lines that mention identifiers found in the error text.
  const quotedWords = Array.from(new Set(headline.match(/['"`]([A-Za-z_$][\w$.]*)['"`]/g)?.map((w) => w.slice(1, -1)) ?? []));
  for (const w of quotedWords.slice(0, 3)) {
    const hit = lines.find((l) => new RegExp(`\\b${escapeRegExp(w)}\\b`).test(l.text));
    if (hit && hit !== stackLine) evidence.push(`\`${w}\` from the error appears on line ${hit.n}: \`${truncate(hit.text)}\`.`);
  }

  // ── Infer the most specific problem, rootCause and fix from what we have ───

  // Heuristic: what function context does the failing line live in?
  const enclosing = stackLine ? findEnclosingFunction(lines, stackLine.n) : findEnclosingFunction(lines, lines.length);
  const fnName = enclosing?.name;

  // Determine a language-aware root cause from error kind + code context.
  let problem = truncate(headline, 140) || "An error was reported.";
  let rootCause: string;
  let confidence: Confidence = "Low";
  let suggestedFix: string;
  let testSuggestion: string;

  // ── Classify by error kind ─────────────────────────────────────────────────
  if (!isJsLike) {
    // Non-JS language: honest about the limitation.
    // Keep the exact phrase "only understands JavaScript and TypeScript" so existing tests pass.
    evidence.push(`The built-in analyzer only understands JavaScript and TypeScript patterns, so it cannot analyse ${input.language} code.`);
    rootCause = `The built-in analyzer only understands JavaScript and TypeScript patterns and cannot diagnose ${input.language} code. The evidence below is taken from the raw input.`;
    suggestedFix = `Use the error message and the stack trace line to locate the problem. Search for \`${truncate(headline, 60)}\` in your ${input.language} documentation for language-specific guidance.`;
    testSuggestion = `Once the cause is identified, write a test that reproduces the error scenario and confirm it passes after the fix.`;
    if (!stackLine && !frame) {
      evidence.push(`No stack trace was provided. Include the full stack trace for a more precise diagnosis.`);
    }
  } else if (kind === "TypeError" || (!kind && /TypeError/i.test(combined))) {
    // TypeError but didn't match the specific handlers above.
    if (stackLine) {
      rootCause = `A \`TypeError\` was thrown on line ${stackLine.n} (\`${truncate(stackLine.text)}\`). This usually means a value that was expected to be an object, function, or array was \`undefined\`, \`null\`, or the wrong type at that point.`;
      suggestedFix = `Inspect the value on line ${stackLine.n} before it is used. Add a type-check or guard (e.g. \`if (typeof x !== "undefined")\`) around the failing operation, or trace back where the value comes from and fix its source.`;
    } else {
      rootCause = `A \`TypeError\` was thrown. This usually means a value that was expected to be an object, function, or array was \`undefined\`, \`null\`, or the wrong type. Include the full stack trace to pinpoint the exact line.`;
      suggestedFix = `Find the line named in the full stack trace and check every value used there. Add defensive checks or TypeScript types to prevent the wrong type from reaching that code.`;
    }
    confidence = stackLine ? "Medium" : "Low";
    testSuggestion = `Write a test that calls the function with the input that triggered the error. Assert it no longer throws after the fix, and also verify the normal case still works.`;
  } else if (kind === "EvalError" || kind === "URIError") {
    rootCause = `A \`${kind}\` was thrown, which usually means an invalid argument was passed to a built-in function (\`eval\`, \`encodeURIComponent\`, \`decodeURIComponent\`, etc.).`;
    suggestedFix = `Validate the argument before passing it to the built-in function. For URI errors, check for malformed percent-encoding or characters that are illegal in a URI component.`;
    confidence = "Medium";
    testSuggestion = `Cover: a valid argument (normal case), the malformed value that caused the error, and an empty string.`;
  } else if (kind && /Error$/i.test(kind) && stackLine) {
    // Some named error + a pinpointed line.
    rootCause = `A \`${kind}\` was thrown at line ${stackLine.n} (\`${truncate(stackLine.text)}\`). ${fnName ? `It originated inside \`${fnName}\`.` : ""} Inspect the values used on that line.`;
    suggestedFix = `Check every value used on line ${stackLine.n}. Verify that none of them can be \`undefined\`, \`null\`, or an unexpected type at runtime. Add a guard or validate inputs earlier in the call chain.`;
    confidence = "Medium";
    testSuggestion = `Write a test that reproduces the failing input and confirm the error no longer occurs after the fix.`;
  } else if (status) {
    // HTTP error without a more specific handler.
    const serverSide = status.startsWith("5");
    problem = `HTTP ${status} error${frame?.fn ? ` in \`${frame.fn}\`` : ""}.`;
    rootCause = serverSide
      ? `The server returned a ${status} error, which indicates a problem on the server side, not in the JavaScript code. The calling code may need to handle this response gracefully.`
      : `The server rejected the request with a ${status} status code, which usually means a client error (wrong URL, missing authentication, bad request body). Check that the request is formed correctly.`;
    suggestedFix = serverSide
      ? `Check the server logs for the root cause. In the client code, add error handling around the fetch/request call so a 5xx response is caught and reported clearly instead of crashing.`
      : `Verify the request URL, method, headers, and body. A ${status} usually means the client sent something the server did not accept.`;
    confidence = "Medium";
    testSuggestion = `Mock the server response in tests: cover a successful response, a ${status} response (should be handled gracefully), and a network error.`;
  } else {
    // Completely unknown — be maximally honest.
    rootCause = `The available information is not enough to identify the root cause with confidence. The error message and the clues below narrow where to look.`;
    const missingInfo: string[] = [];
    if (!frame && !input.stackTrace) missingInfo.push("a stack trace");
    if (lines.length < 3) missingInfo.push("more of the surrounding code");
    if (missingInfo.length > 0) {
      evidence.push(`To get a more precise diagnosis, also provide: ${missingInfo.join(" and ")}.`);
    }
    suggestedFix = stackLine
      ? `Start at line ${stackLine.n} (\`${truncate(stackLine.text)}\`). Check every value used on that line — particularly any that could be \`undefined\`, \`null\`, a different type than expected, or out of range.`
      : `Find the line named in the full stack trace and check every value used there. Add a \`console.log\` before the failing call to inspect the values at runtime.`;
    testSuggestion = `Once the cause is identified, write a test that reproduces the failing scenario and verify it passes after the fix.`;
  }

  return {
    plan: { kind: "generic", fnName },
    result: {
      problem,
      rootCause,
      evidence,
      confidence,
      suggestedFix,
      testSuggestion,
    },
  };
}

// ---------------------------------------------------------------------------
// Pattern 5: SyntaxError
// ---------------------------------------------------------------------------

function analyzeSyntaxError(input: InvestigationInput, combined: string): Analysis | null {
  if (!/SyntaxError\b/i.test(combined)) return null;
  const lines = toLines(input.code);
  const headline = firstLine(input.error);
  const frame = parseStackFrame(input.stackTrace ?? combined);

  // ── Sub-case: server returned HTML instead of JSON ────────────────────────
  // Triggered by: SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
  // or:           SyntaxError: Unexpected non-whitespace character after JSON
  // The '<' is the first byte of an HTML page returned by the server.
  const isHtmlResponse =
    /Unexpected token ['"]?<['"]?/i.test(headline) ||
    /<!DOCTYPE/i.test(combined) ||
    /is not valid JSON/i.test(headline);

  if (isHtmlResponse) {
    const hasFetch = /\bfetch\s*\(/.test(input.code);
    const hasJson = /\.json\s*\(/.test(input.code);
    const fetchLine = lines.find((l) => /\.json\s*\(/.test(l.text)) ?? lines.find((l) => /\bfetch\s*\(/.test(l.text));
    const evidence: string[] = [
      `The error message reads: \`${truncate(headline, 90)}\`.`,
      `The token \`<\` is the first character of an HTML document. \`JSON.parse()\` cannot parse HTML, so the server sent an HTML page (such as a 404 error page or login redirect) instead of the expected JSON.`,
    ];
    if (fetchLine) evidence.push(`Line ${fetchLine.n} (\`${truncate(fetchLine.text)}\`) calls \`${hasFetch && !hasJson ? "fetch" : "response.json()"}\`, which parses the response body as JSON — if the server returns HTML, this throws.`);
    if (hasFetch && hasJson) evidence.push(`The code uses \`fetch\` and \`response.json()\`. \`response.json()\` throws a SyntaxError when the response body is not valid JSON.`);
    evidence.push(`Common causes: the endpoint URL is wrong (returns a 404 HTML page), the server is down (returns a 500 error page), or a redirect sent the request to a login page.`);

    // Build a fixed code that checks response.ok before parsing.
    let fixedCode: string | undefined;
    const responseLine = lines.find((l) => /const\s+(\w+)\s*=\s*await\s+fetch\s*\(/.test(l.text));
    if (responseLine) {
      const responseVar = /const\s+(\w+)\s*=\s*await\s+fetch/.exec(responseLine.text)?.[1] ?? "response";
      const ind = indentOf(responseLine.text) + "  ";
      const insertIdx = responseLine.n; // insert after the fetch line
      const guard = [
        `${indentOf(responseLine.text)}if (!${responseVar}.ok) {`,
        `${ind}throw new Error(\`Server returned \${${responseVar}.status}: \${${responseVar}.statusText}\`);`,
        `${indentOf(responseLine.text)}}`,
      ];
      fixedCode = insertAfterLine(input.code.split("\n"), insertIdx, guard).join("\n");
    }

    const fnName = fetchLine ? findEnclosingFunction(lines, fetchLine.n)?.name : undefined;
    return {
      plan: { kind: "generic", fnName },
      result: {
        problem: `\`response.json()\` received an HTML response instead of JSON, causing a SyntaxError.`,
        rootCause: `The server returned an HTML document (starting with \`<\`) where JSON was expected. This happens when the endpoint URL returns an error page, redirect, or login page instead of the API response. \`response.json()\` always throws when the body is not valid JSON.`,
        evidence,
        confidence: "High",
        suggestedFix: [
          `Check \`response.ok\` (or \`response.status\`) before calling \`.json()\`. When the status is not 2xx, the body is likely an error page, not JSON.`,
          `Why it works: \`response.ok\` is \`false\` for 4xx/5xx responses. Throwing an explicit error at that point gives a clear message instead of a confusing SyntaxError.`,
          `Also verify: is the URL correct? Does the endpoint require authentication? Is the server running?`,
          ...(fixedCode ? [`Fixed code adds an \`if (!${/const\s+(\w+)\s*=\s*await\s+fetch/.exec(responseLine?.text ?? "")?.[1] ?? "response"}.ok)\` guard after the \`fetch\` call.`] : []),
        ].join("\n\n"),
        testSuggestion: `Cover: a mock that returns valid JSON (normal case); a mock that returns a 404 HTML page (the bug — should now throw a clear error, not a SyntaxError); a mock that returns a 500 error page.`,
        ...(fixedCode ? { fixedCode } : {}),
      },
    };
  }

  // ── General SyntaxError ───────────────────────────────────────────────────
  // Extract what the parser found unexpected, if described.
  const unexpected = /Unexpected (token|identifier|end of input|reserved word)\s*['"]?([^\s'"]*)?/i.exec(headline);
  const unexpectedDesc = unexpected ? `${unexpected[1]}${unexpected[2] ? ` \`${unexpected[2]}\`` : ""}` : null;

  // Try to pinpoint the line the parser complained about.
  const targetLine = frame ? lines.find((l) => l.n === frame.line) : undefined;

  const evidence: string[] = [`The error message reads: \`${truncate(headline, 90)}\`.`];
  if (unexpectedDesc) evidence.push(`The parser reports an unexpected ${unexpectedDesc}.`);
  if (targetLine) evidence.push(`The parser points to line ${targetLine.n}: \`${truncate(targetLine.text)}\`.`);

  // Look for common structural mistakes in the code.
  const rawCode = input.code;
  const openBraces = (rawCode.match(/\{/g) ?? []).length;
  const closeBraces = (rawCode.match(/\}/g) ?? []).length;
  const openParens = (rawCode.match(/\(/g) ?? []).length;
  const closeParens = (rawCode.match(/\)/g) ?? []).length;
  const openBrackets = (rawCode.match(/\[/g) ?? []).length;
  const closeBrackets = (rawCode.match(/\]/g) ?? []).length;

  const braceImbalance = openBraces - closeBraces;
  const parenImbalance = openParens - closeParens;
  const bracketImbalance = openBrackets - closeBrackets;

  let structuralHint: string | null = null;
  if (braceImbalance !== 0) structuralHint = `The pasted code has ${Math.abs(braceImbalance)} more ${braceImbalance > 0 ? "opening" : "closing"} brace${Math.abs(braceImbalance) > 1 ? "s" : ""} (\`${braceImbalance > 0 ? "{" : "}"}\`) than ${braceImbalance > 0 ? "closing" : "opening"} ones — a missing brace is a common SyntaxError cause.`;
  else if (parenImbalance !== 0) structuralHint = `The pasted code has ${Math.abs(parenImbalance)} more ${parenImbalance > 0 ? "opening" : "closing"} parenthes${Math.abs(parenImbalance) > 1 ? "es" : "is"} than ${parenImbalance > 0 ? "closing" : "opening"} ones.`;
  else if (bracketImbalance !== 0) structuralHint = `The pasted code has ${Math.abs(bracketImbalance)} more ${bracketImbalance > 0 ? "opening" : "closing"} bracket${Math.abs(bracketImbalance) > 1 ? "s" : ""} (\`${bracketImbalance > 0 ? "[" : "]"}\`) than ${bracketImbalance > 0 ? "closing" : "opening"} ones.`;

  if (structuralHint) evidence.push(structuralHint);

  const hasTargetEvidence = targetLine !== undefined || structuralHint !== null;
  const confidence: Confidence = hasTargetEvidence ? "Medium" : "Low";

  const fnName = targetLine ? findEnclosingFunction(lines, targetLine.n)?.name : findEnclosingFunction(lines, lines.length)?.name;

  const fix = [
    "JavaScript cannot parse this code. Fix the syntax error before running it.",
    targetLine ? `Start at line ${targetLine.n} (\`${truncate(targetLine.text)}\`) where the parser stopped.` : "Check the line the parser points to in the full stack trace.",
    structuralHint ? structuralHint : "Look for: a missing or extra `}`, `)`, or `]`; a stray comma in an object or array literal; a reserved word used as a variable name.",
  ].join("\n\n");

  return {
    plan: { kind: "generic", fnName },
    result: {
      problem: `SyntaxError: the JavaScript parser cannot read this code.`,
      rootCause: unexpectedDesc
        ? `The parser stopped at an unexpected ${unexpectedDesc}. This usually means a bracket, brace, parenthesis, or comma is missing or in the wrong place.`
        : `The code contains a syntax error that prevents JavaScript from parsing it. The exact location is shown in the stack trace.`,
      evidence,
      confidence,
      suggestedFix: fix,
      testSuggestion: "Once the syntax is fixed, write a test that imports the module and calls the function — if the import succeeds, the SyntaxError is resolved.",
    },
  };
}

// ---------------------------------------------------------------------------
// Pattern 6: RangeError — Maximum call stack size exceeded (infinite recursion)
// ---------------------------------------------------------------------------

function analyzeStackOverflow(input: InvestigationInput, combined: string): Analysis | null {
  if (!/RangeError.*(?:Maximum call stack size exceeded|too much recursion|Recursion too deep)/i.test(combined)) return null;
  const lines = toLines(input.code);
  const frame = parseStackFrame(input.stackTrace ?? combined);

  // Find the function that appears to call itself.
  const selfCalls: Array<{ fn: FnContext; callLine: CodeLine }> = [];
  for (const line of lines) {
    const fn = findEnclosingFunction(lines, line.n);
    if (fn && new RegExp(`\\b${escapeRegExp(fn.name)}\\s*\\(`).test(line.text) && line.n !== fn.signatureLine) {
      // Only add if not already recorded for this function.
      if (!selfCalls.some((s) => s.fn.name === fn.name)) {
        selfCalls.push({ fn, callLine: line });
      }
    }
  }

  if (selfCalls.length === 0) {
    // No obvious self-call found in the pasted snippet.
    return null;
  }

  const { fn, callLine } = selfCalls[0];
  const evidence: string[] = [
    `The error \`RangeError: Maximum call stack size exceeded\` means a function kept calling itself until the engine ran out of stack frames — this is infinite recursion.`,
    `\`${fn.name}\` calls itself on line ${callLine.n} (\`${truncate(callLine.text)}\`).`,
  ];

  // Does there appear to be any base-case guard before the recursive call?
  const hasBaseCase = hasGuardBetween(lines, fn.signatureLine, callLine.n, fn.params[0] ?? fn.name);
  if (hasBaseCase) {
    evidence.push(`A conditional before line ${callLine.n} exists, but it may not cover all paths — the recursion still reaches the call.`);
  } else {
    evidence.push(`No conditional guard appears between line ${fn.signatureLine} and line ${callLine.n}, so every call recurses without a stopping condition.`);
  }
  if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}:${frame.col}\`.`);

  return {
    plan: { kind: "stack-overflow", fnName: fn.name },
    result: {
      problem: `\`${fn.name}\` calls itself infinitely, exhausting the call stack.`,
      rootCause: hasBaseCase
        ? `\`${fn.name}\` recurses on line ${callLine.n}, but the base-case condition does not cover all inputs, so the recursion never terminates for some inputs.`
        : `\`${fn.name}\` calls itself on line ${callLine.n} with no base case, so it recurses forever for every input.`,
      evidence,
      confidence: "High",
      suggestedFix: [
        `Add (or fix) a base case in \`${fn.name}\` that returns a value directly without calling \`${fn.name}\` again.`,
        `Why it works: the recursion terminates as soon as the base case is reached.`,
        `Assumption: the pasted snippet is the complete function. If the recursive call is intentional and the base case is in a different part of the code, verify the condition covers all possible input values.`,
      ].join("\n\n"),
      testSuggestion: `Cover: a value that should hit the base case (must not throw), a value one step above the base case, and the input that triggered the crash.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Pattern 7: RangeError — Invalid array length
// ---------------------------------------------------------------------------

function analyzeInvalidArrayLength(input: InvestigationInput, combined: string): Analysis | null {
  if (!/RangeError.*Invalid array length/i.test(combined)) return null;
  const lines = toLines(input.code);
  const frame = parseStackFrame(input.stackTrace ?? combined);
  const headline = firstLine(input.error);

  // Find lines that construct an Array with a size expression.
  const newArrayLine = lines.find((l) => /new\s+Array\s*\(/.test(l.text));
  // Find lines that assign .length directly.
  const lengthAssign = lines.find((l) => /\.length\s*=/.test(l.text));
  const targetLine = newArrayLine ?? lengthAssign ?? (frame ? lines.find((l) => l.n === frame.line) : undefined);

  const evidence: string[] = [`The error message reads: \`${truncate(headline, 90)}\`.`];
  evidence.push(`JavaScript throws \`Invalid array length\` when an array is created or resized with a negative number, a non-integer, or a value larger than 2³²−2.`);
  if (targetLine) evidence.push(`Line ${targetLine.n} (\`${truncate(targetLine.text)}\`) creates or resizes an array — this is likely where the bad length comes from.`);
  if (frame && !targetLine) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}:${frame.col}\`.`);

  const confidence: Confidence = targetLine ? "Medium" : "Low";
  const fnName = targetLine ? findEnclosingFunction(lines, targetLine.n)?.name : undefined;

  return {
    plan: { kind: "generic", fnName },
    result: {
      problem: `An array is being created or resized with an invalid length value.`,
      rootCause: targetLine
        ? `Line ${targetLine.n} (\`${truncate(targetLine.text)}\`) passes a length to an array that is negative, non-integer, or exceeds the JavaScript array limit. Validate the length before using it.`
        : `An array is constructed with a bad length value (negative, non-integer, or too large). Find where the length comes from and validate it before passing it to \`new Array()\` or assigning \`.length\`.`,
      evidence,
      confidence,
      suggestedFix: [
        targetLine
          ? `Validate the length value on line ${targetLine.n} before using it. Ensure it is a non-negative integer (e.g. \`Math.max(0, Math.floor(n))\`) and within a reasonable range.`
          : `Find where the array length value comes from and ensure it is a non-negative integer before creating or resizing the array.`,
        `Why it works: JavaScript requires array lengths to be non-negative integers not exceeding 2³²−2.`,
        `Assumption: the length comes from external input or a calculation. Add a guard or assertion before using it.`,
      ].join("\n\n"),
      testSuggestion: `Cover: a valid positive integer length (normal case), a length of 0, a negative number (the bug), a non-integer (e.g. 1.5), and a value beyond the safe limit.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Pattern 8: X is not a function / X is not iterable
// ---------------------------------------------------------------------------

// Array methods that only exist on Array.prototype
const ARRAY_ONLY_METHODS = new Set(["filter", "map", "reduce", "forEach", "find", "findIndex", "some", "every", "flat", "flatMap", "includes", "indexOf", "lastIndexOf", "sort", "splice", "slice", "fill", "copyWithin"]);

function analyzeNotAFunction(input: InvestigationInput, combined: string): Analysis | null {
  // Match "X is not a function" or "X is not iterable"
  const m =
    /([A-Za-z_$][\w$.]*(?:\.[A-Za-z_$][\w$]*)*)\s+is not (a function|iterable)/i.exec(combined) ??
    /([A-Za-z_$][\w$.]*(?:\.[A-Za-z_$][\w$]*)*) is not (a function|iterable)/i.exec(firstLine(input.error));
  if (!m) return null;

  const callee = m[1];
  const problem = m[2].toLowerCase(); // "a function" or "iterable"
  const lines = toLines(input.code);
  const frame = parseStackFrame(input.stackTrace ?? combined);

  // Decompose: if callee is "users.filter", receiver = "users", method = "filter"
  const dotIdx = callee.lastIndexOf(".");
  const receiverName = dotIdx > 0 ? callee.slice(0, dotIdx) : null;
  const methodName = dotIdx > 0 ? callee.slice(dotIdx + 1) : callee;
  const isArrayMethod = ARRAY_ONLY_METHODS.has(methodName);

  const calleeRe = new RegExp(`\\b${escapeRegExp(callee)}\\b`);

  // Find lines in the code that use the callee.
  const usageLine = frame ? lines.find((l) => l.n === frame.line && calleeRe.test(l.text)) : undefined;
  const anyUsage = usageLine ?? lines.find((l) => calleeRe.test(l.text));

  // Find where the receiver is declared/assigned.
  const receiverBase = receiverName ?? callee.split(".")[0];
  const assignRe = new RegExp(`(?:const|let|var)\\s+${escapeRegExp(receiverBase)}\\s*(?::[^=]+)?=\\s*([^;\\n]+)`);
  const assignLine = lines.find((l) => assignRe.test(l.text));
  const assignedExpr = assignLine ? (assignRe.exec(assignLine.text)?.[1] ?? "").trim() : null;

  // Detect if the receiver is an object literal (not an array).
  const isObjectLiteral = assignedExpr ? /^\{/.test(assignedExpr.trim()) : false;

  const evidence: string[] = [
    `The error says \`${callee}\` is not ${problem}, meaning the code tries to ${problem === "a function" ? `call \`${callee}()\`` : `iterate over \`${callee}\``} but \`${callee}\` holds a different type at runtime.`,
  ];
  if (anyUsage) evidence.push(`\`${callee}\` is ${problem === "a function" ? "called" : "iterated"} on line ${anyUsage.n} (\`${truncate(anyUsage.text)}\`).`);

  // ── Sub-case: Array method called on a plain object ───────────────────────
  if (isArrayMethod && receiverName && (isObjectLiteral || assignedExpr)) {
    if (isObjectLiteral && assignLine) {
      evidence.push(`\`${receiverBase}\` is assigned a plain object (\`{ ... }\`) on line ${assignLine.n} (\`${truncate(assignLine.text)}\`). Plain objects do not have a \`.${methodName}()\` method — that method only exists on Arrays.`);
    } else if (assignLine) {
      evidence.push(`\`${receiverBase}\` is assigned from \`${truncate(assignedExpr ?? "", 60)}\` on line ${assignLine.n}. If that value is a plain object at runtime, \`.${methodName}()\` will not exist on it.`);
    }
    evidence.push(`\`Array.prototype.${methodName}\` only works on arrays, not on plain objects. If the intent is to iterate over object entries, use \`Object.values(${receiverBase})\`, \`Object.keys(${receiverBase})\`, or \`Object.entries(${receiverBase})\` first.`);
    if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}:${frame.col}\`.`);

    // Build a fixed line that wraps the receiver in Object.values() if the usage is a simple call.
    let fixedCode: string | undefined;
    if (anyUsage && assignLine) {
      const fixedLine = anyUsage.text.replace(
        new RegExp(`\\b${escapeRegExp(receiverName)}\\.${escapeRegExp(methodName)}\\s*\\(`),
        `Object.values(${receiverName}).${methodName}(`,
      );
      if (fixedLine !== anyUsage.text) {
        fixedCode = input.code.split("\n").map((l, i) => (i === anyUsage.n - 1 ? fixedLine : l)).join("\n");
      }
    }

    const fn = anyUsage ? findEnclosingFunction(lines, anyUsage.n) : undefined;
    return {
      plan: { kind: "not-a-function", fnName: fn?.name, callee },
      result: {
        problem: `\`${receiverName}\` is a plain object, but \`.${methodName}()\` is an Array method.`,
        rootCause: `\`${methodName}()\` is a method on \`Array.prototype\` and does not exist on plain objects. \`${receiverBase}\`${assignLine ? ` (defined on line ${assignLine.n})` : ""} is an object, not an array, so calling \`.${methodName}()\` on it throws a TypeError.`,
        evidence,
        confidence: isObjectLiteral ? "High" : "Medium",
        suggestedFix: [
          `Option A: change \`${receiverName}\` to be an array instead of a plain object. For example, wrap the value in \`[]\` or change the data source to return an array.`,
          `Option B: if you need to iterate over object values, use \`Object.values(${receiverName}).${methodName}(...)\` instead of \`${callee}(...)\`.`,
          `Why it works: \`Object.values()\` converts the object's values to an array, which has all the Array prototype methods.`,
          ...(fixedCode ? [`The suggested fix changes the call to \`Object.values(${receiverName}).${methodName}(...)\`.`] : []),
        ].join("\n\n"),
        testSuggestion: `Cover: passing an array (normal case — should work); passing the object that caused the error (should now work after fix); passing \`null\` or \`undefined\`.`,
        ...(fixedCode ? { fixedCode } : {}),
      },
    };
  }

  // ── General case ──────────────────────────────────────────────────────────
  if (assignLine) {
    evidence.push(`\`${receiverBase}\` is assigned from \`${truncate(assignedExpr ?? "", 50)}\` on line ${assignLine.n} — check whether that expression always produces ${problem === "a function" ? "a function" : "an iterable (array, string, Map, Set, etc.)"}.`);
  } else if (problem === "a function") {
    evidence.push(`No assignment for \`${callee}\` was found in the pasted code. It may come from an import, a parameter, or an object property — check that the source always exports a function.`);
  }
  if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}:${frame.col}\`.`);

  const confidence: Confidence = anyUsage ? (assignLine ? "High" : "Medium") : "Low";
  const fn = anyUsage ? findEnclosingFunction(lines, anyUsage.n) : undefined;

  return {
    plan: { kind: "not-a-function", fnName: fn?.name, callee },
    result: {
      problem: `\`${callee}\` is not ${problem} at the point it is used.`,
      rootCause: assignLine
        ? `\`${callee}\` is assigned from an expression that does not always produce ${problem === "a function" ? "a callable function" : "an iterable value"}. When the assignment produces the wrong type, the subsequent ${problem === "a function" ? "call" : "iteration"} throws.`
        : `\`${callee}\` is expected to be ${problem === "a function" ? "a callable function" : "an iterable"} but holds a different type at runtime. This is often caused by a typo in a property name, a missing import, or an async function that returns a Promise instead of the expected value.`,
      evidence,
      confidence,
      suggestedFix: [
        problem === "a function"
          ? `Check where \`${callee}\` comes from and make sure it is always a function. Common causes: a typo in the method name, reading a property that does not exist on the object (gives \`undefined\`), or forgetting \`await\` so a Promise is used as the function.`
          : `Check where \`${callee}\` comes from and make sure it is always iterable (an array, string, Map, Set, or other iterable). Common causes: the value is \`undefined\` or \`null\`, or an \`async\` function returns a Promise instead of the array.`,
        `Why it works: type errors like this are prevented by checking the value's type (or using TypeScript types) before the call.`,
        `Tip: add \`console.log(typeof ${callee}, ${callee})\` on the line before the error to see what type it actually holds at runtime.`,
      ].join("\n\n"),
      testSuggestion: `Cover: a valid ${problem === "a function" ? "function" : "iterable"} value (normal case), \`undefined\`, \`null\`, and a wrong-type value (e.g. a number or plain object).`,
    },
  };
}

// ---------------------------------------------------------------------------
// Pattern 9: Missing return — function returns undefined and caller reads a property
// ---------------------------------------------------------------------------

function analyzeMissingReturn(input: InvestigationInput, combined: string): Analysis | null {
  // Only trigger when the error is a TypeError about reading a property of undefined
  // AND there is evidence a function call's result is used immediately.
  const typeErr = parseTypeError(combined);
  if (!typeErr) return null;
  const lines = toLines(input.code);

  // Find the failing property read — same logic as analyzeNullishRead entry.
  const propRe = new RegExp(`\\.\\s*${escapeRegExp(typeErr.prop)}\\b`);
  const frame = parseStackFrame(input.stackTrace ?? combined);
  const stackLine = frame ? lines.find((l) => l.n === frame.line && propRe.test(l.text)) : undefined;
  const failing = stackLine ?? lines.find((l) => propRe.test(l.text));
  if (!failing) return null;

  // The receiver must look like a function call result: someFunc(...).prop
  const callResultRe = new RegExp(`([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\s*\\([^)]*\\)\\.${escapeRegExp(typeErr.prop)}`);
  const callMatch = callResultRe.exec(failing.text);
  if (!callMatch) return null;
  const calledFn = callMatch[1];

  // Find the definition of the called function in the pasted code.
  const fnDefRe = new RegExp(`(?:function\\s+${escapeRegExp(calledFn)}\\b|(?:const|let|var)\\s+${escapeRegExp(calledFn)}\\s*=)`);
  const defLine = lines.find((l) => fnDefRe.test(l.text));
  if (!defLine) return null;

  // Collect all return statements inside that function body.
  const defLineN = defLine.n;
  const fnLines = lines.filter((l) => l.n > defLineN);
  const returnLines = fnLines.filter((l) => /^\s*return\s+/.test(l.text));
  // Look for a code path with no return (a bare "return;" or missing return).
  const bareReturn = fnLines.find((l) => /^\s*return\s*;/.test(l.text));

  if (returnLines.length === 0 && !bareReturn) return null; // No return at all — likely a void function, not a bug we can identify here.
  if (bareReturn === undefined && returnLines.length > 0) return null; // All returns look value-bearing; can't confirm missing return from snippet.

  const evidence: string[] = [
    `The error says \`${typeErr.prop}\` was read from \`${typeErr.nullish}\`, so the expression to the left of \`.${typeErr.prop}\` was ${typeErr.nullish} at runtime.`,
    `Line ${failing.n} (\`${truncate(failing.text)}\`) reads \`.${typeErr.prop}\` directly from the return value of \`${calledFn}()\`.`,
    `\`${calledFn}\` is defined at line ${defLine.n} (\`${truncate(defLine.text)}\`).`,
    bareReturn
      ? `Line ${bareReturn.n} has a bare \`return;\` inside \`${calledFn}\`, which returns \`undefined\`. If this path is taken, the caller receives \`undefined\` and the property read throws.`
      : `\`${calledFn}\` has no \`return\` statement in the pasted snippet, so it implicitly returns \`undefined\`.`,
  ];
  if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}:${frame.col}\`.`);

  const fn = findEnclosingFunction(lines, defLine.n);
  return {
    plan: { kind: "generic", fnName: calledFn },
    result: {
      problem: `\`${calledFn}\` returns \`undefined\` on some path, and the caller reads \`.${typeErr.prop}\` on that result.`,
      rootCause: bareReturn
        ? `\`${calledFn}\` has a bare \`return;\` on line ${bareReturn.n} that returns \`undefined\`. The caller on line ${failing.n} reads \`.${typeErr.prop}\` unconditionally, so when that path is taken the read throws.`
        : `\`${calledFn}\` does not return a value in the pasted code, so it returns \`undefined\` implicitly. The caller reads \`.${typeErr.prop}\` on the result, which throws.`,
      evidence,
      confidence: "Medium",
      suggestedFix: [
        bareReturn
          ? `In \`${calledFn}\`, replace the bare \`return;\` on line ${bareReturn.n} with a return value the caller can safely use (e.g. \`return null;\` or a fallback object), OR guard the caller: check that the result is not null/undefined before reading \`.${typeErr.prop}\`.`
          : `Make sure \`${calledFn}\` returns a value on every code path. If it can legitimately return nothing, the caller on line ${failing.n} must guard against \`undefined\` before reading \`.${typeErr.prop}\`.`,
        `Why it works: the caller only reads the property when it is known to have a value.`,
        `Tip: TypeScript can catch this at compile time — add a return type to \`${calledFn}\` and TypeScript will flag any path that does not return a matching value.`,
      ].join("\n\n"),
      testSuggestion: `Cover: the input that triggers the \`${bareReturn ? "bare return" : "no return"}\` path (should not throw after the fix), a normal input with a full return value, and the case where the caller receives \`null\` or \`undefined\`.`,
      ...(fn ? {} : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Pattern 10: async/await forgotten
// ---------------------------------------------------------------------------

function analyzeAsyncAwaitForgotten(input: InvestigationInput, combined: string): Analysis | null {
  // Signals: "then is not a function" OR using a Promise object where a value is expected,
  // OR property read on a Promise (TypeError: Cannot read properties of undefined on something
  // that looks like an async call result).
  const isThenNotFn = /\.then\s+is not a function/i.test(combined);
  const isPromiseProp = /\[object Promise\]/i.test(combined);

  // Also catch the case where the error is a TypeError on a property that the code reads
  // directly from an async function call result without await.
  const typeErr = parseTypeError(combined);
  const lines = toLines(input.code);

  // Detect an async function call whose result is used without await.
  // Look for: const x = someAsyncFn(...) where someAsyncFn is declared async.
  const asyncFnNames: string[] = [];
  for (const line of lines) {
    const m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*async\s*(?:function|\()/.exec(line.text)
      ?? /^\s*(?:export\s+)?async\s+function\s+([A-Za-z_$][\w$]*)/.exec(line.text);
    if (m) asyncFnNames.push(m[1]);
  }

  if (!isThenNotFn && !isPromiseProp && asyncFnNames.length === 0) return null;

  // Find a line that calls an async function without await.
  let suspectLine: CodeLine | undefined;
  let suspectFn: string | undefined;
  for (const fnName of asyncFnNames) {
    const callRe = new RegExp(`(?<!await\\s{0,10})(?<![Aa]wait\\s)\\b${escapeRegExp(fnName)}\\s*\\(`);
    const hit = lines.find((l) => callRe.test(l.text) && !/^\s*(?:async\s+)?function|const|let|var/.test(l.text));
    if (hit) { suspectLine = hit; suspectFn = fnName; break; }
  }

  if (!isThenNotFn && !isPromiseProp && !suspectLine) return null;

  const evidence: string[] = [];
  if (isThenNotFn) evidence.push(`The error says \`.then\` is not a function. This often happens when \`.then()\` is called on a value that is already resolved — usually because \`await\` was used where it should not be, or the function does not return a Promise.`);
  if (isPromiseProp) evidence.push(`The string \`[object Promise]\` appears in the error, which means a Promise object was used as if it were its resolved value.`);
  if (suspectLine && suspectFn) {
    evidence.push(`\`${suspectFn}\` is declared \`async\` in the pasted code but is called on line ${suspectLine.n} (\`${truncate(suspectLine.text)}\`) without \`await\`. Without \`await\`, the call returns a \`Promise\` object instead of the resolved value.`);
  }
  if (asyncFnNames.length > 0 && !suspectLine) {
    evidence.push(`The pasted code defines the async function${asyncFnNames.length > 1 ? "s" : ""} \`${asyncFnNames.join("`, `")}\`. Make sure every call site uses \`await\` (or \`.then()\`) to get the resolved value.`);
  }
  if (typeErr && suspectLine) {
    evidence.push(`The error tries to read \`.${typeErr.prop}\` from \`${typeErr.nullish}\` — this is consistent with reading a property on a \`Promise\` object, which does not have a \`.${typeErr.prop}\` field.`);
  }

  const confidence: Confidence = (isThenNotFn || isPromiseProp) ? "High" : suspectLine ? "Medium" : "Low";
  const fn = suspectLine ? findEnclosingFunction(lines, suspectLine.n) : undefined;

  return {
    plan: { kind: "generic", fnName: fn?.name },
    result: {
      problem: suspectFn
        ? `\`${suspectFn}\` is called without \`await\`, so its result is a \`Promise\` object instead of the resolved value.`
        : `An \`async\` function's result is used as a plain value without awaiting the \`Promise\`.`,
      rootCause: suspectLine && suspectFn
        ? `\`${suspectFn}\` is an \`async\` function. Calling it without \`await\` on line ${suspectLine.n} gives back a \`Promise\` object. Any property access or method call on that \`Promise\` (other than \`.then\`/\`.catch\`) will not find the data the function produces.`
        : `An \`async\` function is used without \`await\` or \`.then()\`, so the resolved value is never extracted from the \`Promise\`.`,
      evidence,
      confidence,
      suggestedFix: [
        suspectLine && suspectFn
          ? `Add \`await\` before the call on line ${suspectLine.n}: \`const result = await ${suspectFn}(...);\`. Make sure the calling function is also declared \`async\`.`
          : `Add \`await\` before every call to the async function, or use \`.then(value => ...)\` to handle the resolved result. Make sure the surrounding function is declared \`async\` if using \`await\`.`,
        `Why it works: \`await\` pauses execution until the \`Promise\` resolves and unwraps its value.`,
        `Tip: if you cannot use \`async/await\` in the calling context, use \`.then(result => { /* use result here */ })\` instead.`,
      ].join("\n\n"),
      testSuggestion: `Cover: awaiting the result produces the expected value (normal case); not awaiting gives a \`Promise\` object (verify the type is correct after the fix); and error handling when the promise rejects.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Pattern 11: Network / fetch failure
// ---------------------------------------------------------------------------

function analyzeNetworkFailure(input: InvestigationInput, combined: string): Analysis | null {
  const isNetworkError =
    /TypeError:\s*(?:Failed to fetch|NetworkError|Load failed|Network request failed)/i.test(combined) ||
    /net::ERR_[A-Z_]+/i.test(combined) ||
    /CORS|Access-Control-Allow-Origin/i.test(combined) ||
    /ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED/i.test(combined);

  if (!isNetworkError) return null;

  const lines = toLines(input.code);
  const headline = firstLine(input.error);
  const frame = parseStackFrame(input.stackTrace ?? combined);

  const isCORS = /CORS|Access-Control-Allow-Origin/i.test(combined);
  const isConnectionRefused = /ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(combined);
  const isNameNotResolved = /ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(combined);

  // Find the fetch/axios/XMLHttpRequest call in the code.
  const fetchLine =
    lines.find((l) => /\bfetch\s*\(/.test(l.text)) ??
    lines.find((l) => /axios\s*\.\s*(?:get|post|put|delete|patch|request)\s*\(/.test(l.text)) ??
    lines.find((l) => /new\s+XMLHttpRequest\s*\(/.test(l.text));

  // Extract the URL from the fetch call if visible.
  const urlMatch = fetchLine ? /fetch\s*\(\s*(['"`])([^'"`]+)\1/.exec(fetchLine.text) : null;
  const url = urlMatch?.[2];

  const evidence: string[] = [`The error message reads: \`${truncate(headline, 90)}\`.`];

  if (isCORS) {
    evidence.push(`The error mentions CORS (Cross-Origin Resource Sharing). Browsers block requests from one origin (domain/protocol/port) to another unless the server explicitly allows it with the \`Access-Control-Allow-Origin\` header.`);
    if (url) evidence.push(`The request is made to \`${url}\`. If this origin differs from the page's origin, the server must include CORS headers in its response.`);
    if (fetchLine) evidence.push(`Line ${fetchLine.n} (\`${truncate(fetchLine.text)}\`) makes the request that was blocked.`);
    evidence.push(`CORS errors only appear in browsers, not in Node.js. The server-side code or server configuration controls whether CORS is allowed.`);
  } else if (isConnectionRefused) {
    evidence.push(`\`ERR_CONNECTION_REFUSED\` means the server actively refused the connection. The server is either not running, listening on a different port, or blocked by a firewall.`);
    if (url) evidence.push(`The request target is \`${url}\`. Check that the server is running and listening at that address and port.`);
    if (fetchLine) evidence.push(`Line ${fetchLine.n} (\`${truncate(fetchLine.text)}\`) makes the failing request.`);
  } else if (isNameNotResolved) {
    evidence.push(`\`ERR_NAME_NOT_RESOLVED\` means the DNS lookup for the hostname failed — the domain could not be resolved to an IP address.`);
    if (url) evidence.push(`The request target is \`${url}\`. Check that the hostname is spelled correctly and that the machine has internet access.`);
    if (fetchLine) evidence.push(`Line ${fetchLine.n} (\`${truncate(fetchLine.text)}\`) makes the failing request.`);
  } else {
    evidence.push(`A network error means the request could not be completed at the transport level — the browser or Node.js could not reach the server.`);
    if (fetchLine) evidence.push(`Line ${fetchLine.n} (\`${truncate(fetchLine.text)}\`) makes the failing request.`);
    if (url) evidence.push(`The request target is \`${url}\`.`);
    evidence.push(`Common causes: no internet connection, the server is down, a proxy is blocking the request, or the URL is incorrect.`);
  }
  if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}:${frame.col}\`.`);

  const fnName = fetchLine ? findEnclosingFunction(lines, fetchLine.n)?.name : undefined;

  // Check whether the code has error handling around the fetch call.
  const hasErrorHandling =
    /\.catch\s*\(/.test(input.code) ||
    /try\s*\{/.test(input.code);
  if (!hasErrorHandling) {
    evidence.push(`The pasted code does not appear to have a \`try/catch\` or \`.catch()\` around the network call. Unhandled network errors will crash the calling code.`);
  }

  return {
    plan: { kind: "generic", fnName },
    result: {
      problem: isCORS
        ? `The browser blocked the request due to a CORS policy violation.`
        : isConnectionRefused
          ? `The server refused the connection — it may not be running.`
          : `The network request could not reach the server.`,
      rootCause: isCORS
        ? `The server at the target origin does not include the \`Access-Control-Allow-Origin\` header (or its value does not include the current page's origin), so the browser refuses to deliver the response. CORS is enforced by the browser; the server must be configured to allow the request.`
        : isConnectionRefused
          ? `The target server is not accepting connections on the requested address and port. The server may be stopped, the port may be wrong, or a firewall is blocking the connection.`
          : isNameNotResolved
            ? `The hostname in the URL cannot be resolved by DNS. The domain name is either misspelled, not registered, or the machine has no internet access.`
            : `The network request failed before receiving a response. This is a transport-level failure, not an error returned by the server.`,
      evidence,
      confidence: isCORS || isConnectionRefused || isNameNotResolved ? "High" : "Medium",
      suggestedFix: isCORS
        ? [
            `Fix CORS on the server: add the \`Access-Control-Allow-Origin: <your-origin>\` header to the server's response (or \`*\` for public APIs).`,
            `During development: use a proxy (e.g. Next.js rewrites, Vite proxy config) to forward requests from the same origin.`,
            `This cannot be fixed in browser JavaScript — the server must send the correct headers.`,
          ].join("\n\n")
        : isConnectionRefused
          ? [
              `Verify the server is running and listening on the correct port.`,
              `Check the URL in the fetch call: make sure the hostname, port, and protocol match the running server.`,
              `If the server is a local dev server, start it first (e.g. \`npm run dev\`).`,
            ].join("\n\n")
          : [
              `Wrap the fetch call in a \`try/catch\` block so network failures are handled gracefully instead of crashing the app.`,
              `Verify the URL is correct and the server is reachable from the current environment.`,
              `Add retry logic or a user-facing error message for when the network is unavailable.`,
            ].join("\n\n"),
      testSuggestion: `Mock the fetch/network layer in tests (e.g. \`vi.stubGlobal("fetch", ...)\` or \`nock\`): cover a successful response, a network failure (should be caught gracefully), and ${isCORS ? "a CORS-blocked response" : "a timeout"}.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Pattern 12: Unhandled promise rejection
// ---------------------------------------------------------------------------

function analyzeUnhandledRejection(input: InvestigationInput, combined: string): Analysis | null {
  const isUnhandled =
    /UnhandledPromiseRejection/i.test(combined) ||
    /Unhandled promise rejection/i.test(combined) ||
    /UnhandledPromiseRejectionWarning/i.test(combined) ||
    /Promise rejection was handled late/i.test(combined);

  if (!isUnhandled) return null;

  const lines = toLines(input.code);
  const headline = firstLine(input.error);
  const frame = parseStackFrame(input.stackTrace ?? combined);

  // Extract the inner error message from the rejection if present.
  const innerError = /UnhandledPromiseRejection.*?:\s*(.+)/.exec(combined)?.[1]?.trim() ??
    /Unhandled promise rejection\s*:?\s*(.+)/i.exec(combined)?.[1]?.trim();

  // Find async operations in the code.
  const asyncLines = lines.filter((l) => /\bawait\s+/.test(l.text) || /\.then\s*\(/.test(l.text) || /new\s+Promise\s*\(/.test(l.text));
  const hasCatch = /\.catch\s*\(/.test(input.code) || /catch\s*\(/.test(input.code);

  const evidence: string[] = [`The error message reads: \`${truncate(headline, 90)}\`.`];
  if (innerError && innerError !== headline) {
    evidence.push(`The rejected Promise carries the inner error: \`${truncate(innerError, 90)}\`.`);
  }
  evidence.push(`An \`UnhandledPromiseRejection\` means a Promise was rejected but no \`.catch()\` handler or \`try/catch\` block was in place to handle the rejection. In Node.js 15+ this terminates the process.`);

  if (asyncLines.length > 0 && !hasCatch) {
    evidence.push(`The pasted code has ${asyncLines.length} async operation${asyncLines.length > 1 ? "s" : ""} (line${asyncLines.length > 1 ? "s" : ""} ${asyncLines.map((l) => l.n).join(", ")}) but no visible \`.catch()\` or \`try/catch\` block.`);
  } else if (!hasCatch) {
    evidence.push(`No \`.catch()\` or \`try/catch\` was found in the pasted code. Every \`await\` expression and \`.then()\` chain should have an error handler.`);
  } else {
    evidence.push(`A \`.catch()\` or \`try/catch\` exists in the pasted code, but the rejection reached an uncaught path. Check that every async code path is covered.`);
  }
  if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}:${frame.col}\`.`);

  const fnName = asyncLines[0] ? findEnclosingFunction(lines, asyncLines[0].n)?.name : undefined;

  return {
    plan: { kind: "generic", fnName },
    result: {
      problem: `A Promise was rejected without a handler, causing an unhandled rejection.`,
      rootCause: innerError
        ? `A Promise rejected with \`${truncate(innerError, 80)}\` was never caught. In Node.js 15+ and modern browsers, unhandled rejections terminate the process or generate a loud warning.`
        : `A Promise was rejected but no \`.catch()\` handler or \`try/catch\` was present on that code path. The rejection propagated to the top level, causing an \`UnhandledPromiseRejection\`.`,
      evidence,
      confidence: "High",
      suggestedFix: [
        `Wrap every \`await\` call in a \`try/catch\` block, or add a \`.catch()\` handler to every \`.then()\` chain.`,
        `Why it works: the rejection is intercepted before it reaches the top level, so the process does not crash.`,
        `Example:\n\`\`\`\ntry {\n  const result = await someAsyncOperation();\n} catch (err) {\n  console.error("Operation failed:", err);\n  // handle or re-throw\n}\n\`\`\``,
        `If you intentionally do not need the result, still add \`.catch(() => {})\` or \`void yourPromise.catch(err => log(err))\` to suppress the warning.`,
      ].join("\n\n"),
      testSuggestion: `Cover: the async function resolving successfully (normal case); the async function rejecting (should be caught without crashing); and the rejection carrying a specific error message that can be asserted.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Pattern 13: Logic / wrong-operator error
// ---------------------------------------------------------------------------

function analyzeLogicError(input: InvestigationInput, combined: string): Analysis | null {
  const lines = toLines(input.code);
  const headline = firstLine(input.error);

  // Only engage when the error is generic enough that a logic mistake is plausible.
  // We look for structural clues in the code itself.
  const isGenericError = /^Error:/i.test(headline) || /assertion/i.test(headline) || /expected.*received/i.test(combined);
  if (!isGenericError && !/NaN/i.test(combined) && !/Infinity/i.test(combined)) return null;

  const evidence: string[] = [`The error message reads: \`${truncate(headline, 90)}\`.`];
  const suspects: string[] = [];

  // ── NaN propagation ──────────────────────────────────────────────────────
  const hasNaN = /\bNaN\b/.test(combined);
  if (hasNaN) {
    evidence.push(`\`NaN\` (Not a Number) appears in the error. \`NaN\` propagates silently through arithmetic: any operation on \`NaN\` returns \`NaN\`. This is usually caused by parsing a non-numeric string with \`parseInt\`/\`parseFloat\`, dividing by zero, or applying math to \`undefined\`.`);
    const nanLines = lines.filter((l) => /\bparseInt\b|\bparseFloat\b|\bNumber\s*\(/.test(l.text) || /[+\-*/]\s*\bundefined\b/.test(l.text));
    for (const l of nanLines.slice(0, 2)) {
      evidence.push(`Line ${l.n} (\`${truncate(l.text)}\`) performs a numeric operation or conversion that could produce \`NaN\` if the input is not a valid number.`);
    }
    suspects.push("NaN");
  }

  // ── Assignment used as condition (= vs ==) ────────────────────────────────
  const assignInCondition = lines.find((l) => /\bif\s*\([^=!<>]+=[^=]/.test(l.text) && !/=>/g.test(l.text));
  if (assignInCondition) {
    evidence.push(`Line ${assignInCondition.n} (\`${truncate(assignInCondition.text)}\`) uses a single \`=\` inside an \`if\` condition. This is an assignment, not a comparison. The condition will always be truthy (unless the assigned value is falsy), which is almost always a bug. Use \`===\` to compare.`);
    suspects.push("assignment-in-condition");
  }

  // ── Division by zero ─────────────────────────────────────────────────────
  const divByZeroLine = lines.find((l) => /\/\s*0\b/.test(l.text) && !/\/\//.test(l.text.slice(0, l.text.indexOf("/0"))));
  if (divByZeroLine) {
    evidence.push(`Line ${divByZeroLine.n} (\`${truncate(divByZeroLine.text)}\`) divides by the literal \`0\`. In JavaScript this produces \`Infinity\` or \`NaN\`, not a thrown error, but the downstream calculation will produce wrong results.`);
    suspects.push("divide-by-zero");
  }

  // ── Off-by-one: comparing length with <= instead of < (or vice versa) ────
  const offByOne = lines.find((l) => /\[\s*[\w.]+\s*\.\s*length\s*\]/.test(l.text));
  if (offByOne) {
    evidence.push(`Line ${offByOne.n} (\`${truncate(offByOne.text)}\`) accesses an array using \`.length\` as the index. Arrays are zero-indexed, so the last element is at index \`length - 1\`. Accessing \`arr[arr.length]\` returns \`undefined\`.`);
    suspects.push("off-by-one");
  }

  // ── Loose equality with null/undefined (== instead of ===) ───────────────
  const looseNull = lines.find((l) => /[^=!]==[^=]/.test(l.text) && /null|undefined/.test(l.text));
  if (looseNull) {
    evidence.push(`Line ${looseNull.n} (\`${truncate(looseNull.text)}\`) uses \`==\` with \`null\` or \`undefined\`. While \`== null\` catches both \`null\` and \`undefined\`, use \`=== null\` and \`=== undefined\` explicitly for clarity and to avoid unexpected coercions.`);
    suspects.push("loose-equality");
  }

  // Only return if at least one concrete logic suspect was found.
  if (suspects.length === 0) return null;

  const frame = parseStackFrame(input.stackTrace ?? combined);
  if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}:${frame.col}\`.`);

  const fnName = findEnclosingFunction(lines, lines.length)?.name;

  const fixParts: string[] = [];
  if (suspects.includes("NaN")) fixParts.push(`Validate numeric inputs before performing arithmetic. Use \`Number.isNaN()\` or \`Number.isFinite()\` to guard against \`NaN\` and \`Infinity\`. Use \`Number(x)\` with a fallback: \`const n = Number(x); if (Number.isNaN(n)) throw new Error("Expected a number");\``);
  if (suspects.includes("assignment-in-condition")) fixParts.push(`Change \`=\` to \`===\` in the \`if\` condition on line ${assignInCondition!.n} to compare instead of assign.`);
  if (suspects.includes("divide-by-zero")) fixParts.push(`Guard against a zero divisor before the division on line ${divByZeroLine!.n}: \`if (denominator === 0) throw new Error("Cannot divide by zero");\``);
  if (suspects.includes("off-by-one")) fixParts.push(`Use \`arr[arr.length - 1]\` to access the last element, not \`arr[arr.length]\`.`);
  if (suspects.includes("loose-equality")) fixParts.push(`Replace \`== null\` with explicit \`=== null || === undefined\` checks, or use the intentional \`== null\` idiom only when you deliberately want to catch both.`);

  return {
    plan: { kind: "generic", fnName },
    result: {
      problem: `A logic error was detected in the code: ${suspects.join(", ")}.`,
      rootCause: `The code contains a logic mistake that produces incorrect results or throws: ${suspects.map((s) => {
        if (s === "NaN") return "a \`NaN\` value propagates through arithmetic because a numeric conversion produced a non-number";
        if (s === "assignment-in-condition") return `an assignment (\`=\`) is used inside an \`if\` condition instead of a comparison (\`===\`)`;
        if (s === "divide-by-zero") return "a literal \`0\` is used as a divisor";
        if (s === "off-by-one") return "an array is accessed at index \`.length\` (one past the end)";
        if (s === "loose-equality") return "\`==\` is used with \`null\`/\`undefined\` where \`===\` was likely intended";
        return s;
      }).join("; ")}.`,
      evidence,
      confidence: suspects.length > 0 ? "Medium" : "Low",
      suggestedFix: fixParts.join("\n\n"),
      testSuggestion: `Cover: a normal input that produces the correct result; the input that triggered the error; and boundary values (zero, empty, \`null\`, \`NaN\`).`,
    },
  };
}

// ===========================================================================
// Python analyzer — rule-based, partial support
// ===========================================================================

/** Find the deepest (most recent) Python stack frame. */
function lastPythonFrame(text: string): { file: string; line: number; fn?: string } | null {
  const matches = [...text.matchAll(/File "([^"]+)",\s+line (\d+)(?:,\s+in\s+(\S+))?/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return { file: last[1], line: Number(last[2]), fn: last[3] };
}

type PyLine = { n: number; text: string };
function toPyLines(code: string): PyLine[] {
  return code.split("\n").map((text, i) => ({ n: i + 1, text }));
}

function pyTrunc(s: string, max = 70): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function analyzePython(input: InvestigationInput, combined: string): Analysis | null {
  const headline = firstLine(input.error);
  const lines = toPyLines(input.code);
  const frame = lastPythonFrame(combined);

  // ── P1: IndexError ────────────────────────────────────────────────────────
  if (/\bIndexError\b/.test(combined)) {
    const indexLine = frame ? lines.find((l) => l.n === frame.line) : undefined;
    const listAccess = indexLine ?? lines.find((l) => /\[\s*[\w\-+*/]+\s*\]/.test(l.text));
    const evidence: string[] = [`The error message reads: \`${pyTrunc(headline)}\`.`];
    evidence.push(`\`IndexError\` in Python means you tried to access a list (or tuple/string) at an index that does not exist — the index is either negative beyond the start, or ≥ the length of the sequence.`);
    if (listAccess) evidence.push(`Line ${listAccess.n} (\`${pyTrunc(listAccess.text)}\`) accesses a sequence by index.`);
    if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\`${frame.fn ? ` in \`${frame.fn}\`` : ""}.`);
    const hasLenCheck = /\blen\s*\(/.test(input.code);
    if (!hasLenCheck) evidence.push(`No \`len()\` check was found before the index access.`);
    return {
      plan: { kind: "generic", fnName: frame?.fn },
      result: {
        problem: `A sequence (list, tuple, or string) was accessed at an index that is out of range.`,
        rootCause: listAccess
          ? `Line ${listAccess.n} accesses a sequence by index but does not verify that the index is within bounds. When the sequence is shorter than expected — or empty — this throws \`IndexError\`.`
          : `A sequence is accessed at an index that does not exist. Check that the sequence has at least as many elements as the highest index you use.`,
        evidence,
        confidence: listAccess ? "High" : "Medium",
        suggestedFix: [
          listAccess
            ? `Before the access on line ${listAccess.n}, check that the index is within bounds: \`if index < len(sequence):\` or use a try/except block.`
            : `Add a bounds check before every index access: \`if 0 <= idx < len(seq):\`.`,
          `Why it works: accessing a sequence only when the index is valid prevents \`IndexError\`.`,
          `Alternative: use \`.get(index, default)\` (for dicts) or catch \`IndexError\` and provide a fallback value.`,
        ].join("\n\n"),
        testSuggestion: `Cover: a list with enough elements (normal case), an empty list (the bug), and an index that equals the list length.`,
      },
    };
  }

  // ── P2: KeyError ──────────────────────────────────────────────────────────
  const keyErr = /\bKeyError\b:\s*(.+)/.exec(combined);
  if (keyErr) {
    const missingKey = keyErr[1].trim().replace(/^['"]|['"]$/g, "");
    const evidence: string[] = [`The error message reads: \`${pyTrunc(headline)}\`.`];
    evidence.push(`\`KeyError: ${missingKey}\` means the dictionary does not contain the key \`${missingKey}\` at the moment it was accessed.`);
    const keyRe = new RegExp(`\\[\\s*['"]${escapeRegExp(missingKey)}['"]\\s*\\]|\\[\\s*${escapeRegExp(missingKey)}\\s*\\]`);
    const accessLine = lines.find((l) => keyRe.test(l.text));
    if (accessLine) evidence.push(`Line ${accessLine.n} (\`${pyTrunc(accessLine.text)}\`) accesses the key \`${missingKey}\` directly.`);
    if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\`${frame.fn ? ` in \`${frame.fn}\`` : ""}.`);
    const hasGetMethod = new RegExp(`\\.get\\s*\\(\\s*['"]${escapeRegExp(missingKey)}['"]`).test(input.code);
    if (hasGetMethod) evidence.push(`A \`.get("${missingKey}")\` call exists elsewhere — make sure all accesses use the safe form.`);
    return {
      plan: { kind: "generic", fnName: frame?.fn },
      result: {
        problem: `The dictionary key \`${missingKey}\` does not exist at the time it is accessed.`,
        rootCause: accessLine
          ? `Line ${accessLine.n} uses \`dict["${missingKey}"]\`, which throws \`KeyError\` when the key is absent. Use \`dict.get("${missingKey}")\` to return a default instead, or check first with \`if "${missingKey}" in dict:\`.`
          : `A dictionary is accessed with key \`${missingKey}\` which is not present. Either the key was never set, was deleted, or the data source returned a different key name.`,
        evidence,
        confidence: accessLine ? "High" : "Medium",
        suggestedFix: [
          `Replace \`dict["${missingKey}"]\` with \`dict.get("${missingKey}")\` (returns \`None\` when missing) or \`dict.get("${missingKey}", default_value)\`.`,
          `Alternatively, guard with: \`if "${missingKey}" in my_dict: value = my_dict["${missingKey}"]\`.`,
          `Why it works: \`.get()\` never raises \`KeyError\` — it returns \`None\` (or your default) when the key is absent.`,
        ].join("\n\n"),
        testSuggestion: `Cover: a dict that contains the key (normal case), a dict missing the key (the bug), and an empty dict.`,
      },
    };
  }

  // ── P3: TypeError ─────────────────────────────────────────────────────────
  const pyTypeErr = /\bTypeError\b:\s*(.+)/.exec(combined);
  if (pyTypeErr) {
    const detail = pyTypeErr[1].trim();
    const evidence: string[] = [`The error message reads: \`${pyTrunc(headline)}\`.`];
    // "unsupported operand type(s) for +: 'int' and 'str'"
    const operandM = /unsupported operand type\(s\) for (.+?):\s*'([^']+)' and '([^']+)'/.exec(detail);
    // "'NoneType' object is not iterable"
    const noneIterM = /'NoneType' object is not (iterable|subscriptable|callable)/.exec(detail);
    // "can only concatenate str (not 'int') to str"
    const concatM = /can only concatenate (\w+) \(not '(\w+)'\) to \1/.exec(detail);

    let rootCause: string;
    let confidence: Confidence = "Medium";
    if (operandM) {
      const op = operandM[1], t1 = operandM[2], t2 = operandM[3];
      evidence.push(`Python cannot apply the \`${op}\` operator between \`${t1}\` and \`${t2}\` — the types are incompatible.`);
      const opLine = lines.find((l) => new RegExp(`[${escapeRegExp(op)}]`).test(l.text));
      if (opLine) evidence.push(`Line ${opLine.n} (\`${pyTrunc(opLine.text)}\`) performs a mixed-type operation.`);
      if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\`.`);
      rootCause = `The \`${op}\` operator was applied to a \`${t1}\` and a \`${t2}\`. Python does not automatically convert types — you must do so explicitly.`;
      confidence = "High";
    } else if (noneIterM) {
      evidence.push(`\`NoneType\` means the value is \`None\`. Iterating over, subscripting, or calling \`None\` throws \`TypeError\`.`);
      evidence.push(`A function or expression returned \`None\` when a sequence or callable was expected. Check whether the variable was assigned correctly.`);
      if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\`.`);
      rootCause = `The value is \`None\` (the function returned nothing, or an assignment failed), so it cannot be iterated/subscripted/called.`;
      confidence = "High";
    } else if (concatM) {
      evidence.push(`Python does not allow concatenating \`${concatM[1]}\` with \`${concatM[2]}\` using \`+\`. Convert the \`${concatM[2]}\` to \`${concatM[1]}\` first.`);
      rootCause = `Mixed types in a \`+\` concatenation: a \`${concatM[1]}\` and a \`${concatM[2]}\`. Use \`str(value)\` or an f-string.`;
      confidence = "High";
    } else {
      evidence.push(`\`TypeError\` in Python means an operation was applied to a value of the wrong type.`);
      if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\`.`);
      rootCause = `A value of the wrong type was passed to or used in an operation. Check the types of every value involved at the failing line.`;
    }
    return {
      plan: { kind: "generic", fnName: frame?.fn },
      result: {
        problem: `TypeError: ${pyTrunc(detail, 120)}`,
        rootCause,
        evidence,
        confidence,
        suggestedFix: operandM
          ? `Convert one of the values to a compatible type before the operation. For example: \`int(value)\`, \`str(value)\`, or \`float(value)\` as appropriate.`
          : noneIterM
            ? `Trace back where the \`None\` value comes from. Ensure the function or expression that produced it always returns a real value. Add a guard: \`if value is not None:\` before using it.`
            : `Check the types of every value at the failing line. Use \`type(value)\` or \`isinstance(value, expected_type)\` to verify types before operations.`,
        testSuggestion: `Cover: the inputs that caused the TypeError, a normal valid input, and \`None\` as input.`,
      },
    };
  }

  // ── P4: NameError ─────────────────────────────────────────────────────────
  const nameErr = /\bNameError\b:\s*name '([^']+)' is not defined/.exec(combined);
  if (nameErr) {
    const name = nameErr[1];
    const evidence: string[] = [`The error message reads: \`${pyTrunc(headline)}\`.`];
    evidence.push(`\`NameError\` means Python cannot find a variable, function, or module named \`${name}\` in the current scope.`);
    const nameRe = new RegExp(`\\b${escapeRegExp(name)}\\b`);
    const usageLine = lines.find((l) => nameRe.test(l.text));
    if (usageLine) evidence.push(`\`${name}\` is used on line ${usageLine.n} (\`${pyTrunc(usageLine.text)}\`).`);
    const importLine = lines.find((l) => /^import\b|^from\b/.test(l.text.trim()) && l.text.includes(name));
    if (importLine) evidence.push(`An import mentioning \`${name}\` exists on line ${importLine.n}, but it may not have run or may have failed.`);
    const assignBefore = lines.filter((l) => usageLine ? l.n < usageLine.n : true).find((l) => new RegExp(`\\b${escapeRegExp(name)}\\s*=`).test(l.text));
    if (!assignBefore && !importLine) evidence.push(`No assignment or import for \`${name}\` appears before its use in the pasted code.`);
    if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\`.`);
    return {
      plan: { kind: "generic", fnName: frame?.fn },
      result: {
        problem: `\`${name}\` is used but has not been defined.`,
        rootCause: importLine
          ? `\`${name}\` is mentioned in an import but may not be available in the current scope — the import may have failed, or \`${name}\` is not exported by the module.`
          : assignBefore
            ? `\`${name}\` is defined on line ${assignBefore.n} but may not have been executed before its use (e.g. defined inside a conditional block).`
            : `\`${name}\` has not been assigned, imported, or passed in as a parameter. It may be a typo, a missing import, or a variable defined in another scope.`,
        evidence,
        confidence: usageLine ? "High" : "Medium",
        suggestedFix: `Define \`${name}\` before using it, import it (\`import ${name}\` or \`from module import ${name}\`), or pass it as a parameter. If it is a typo, correct the name.`,
        testSuggestion: `Cover: calling the code with \`${name}\` properly defined (normal case), and verifying it no longer raises \`NameError\`.`,
      },
    };
  }

  // ── P5: AttributeError ───────────────────────────────────────────────────
  const attrErr = /\bAttributeError\b:\s*(.+)/.exec(combined);
  if (attrErr) {
    const detail = attrErr[1].trim();
    const noneAttr = /'NoneType' object has no attribute '([^']+)'/.exec(detail);
    const objAttr = /'([^']+)' object has no attribute '([^']+)'/.exec(detail);
    const evidence: string[] = [`The error message reads: \`${pyTrunc(headline)}\`.`];
    let rootCause: string;
    let confidence: Confidence = "Medium";
    if (noneAttr) {
      const attr = noneAttr[1];
      evidence.push(`The object is \`None\`. Reading attribute \`${attr}\` from \`None\` always raises \`AttributeError\`.`);
      const attrLine = lines.find((l) => new RegExp(`\\.${escapeRegExp(attr)}\\b`).test(l.text));
      if (attrLine) evidence.push(`Line ${attrLine.n} (\`${pyTrunc(attrLine.text)}\`) reads \`.${attr}\` without checking for \`None\`.`);
      if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\`.`);
      rootCause = `A variable that is \`None\` is used as if it has an attribute \`${attr}\`. The function or expression that produced the variable returned \`None\` instead of an object.`;
      confidence = "High";
      return {
        plan: { kind: "generic", fnName: frame?.fn },
        result: {
          problem: `\`None\` has no attribute \`${attr}\` — the variable is \`None\` when an object is expected.`,
          rootCause,
          evidence,
          confidence,
          suggestedFix: [
            `Add a \`None\` check before accessing \`.${attr}\`: \`if obj is not None: value = obj.${attr}\`.`,
            `Or use the walrus operator: \`if (obj := get_something()) is not None: value = obj.${attr}\`.`,
            `Why it works: the attribute is only read when the object actually exists.`,
          ].join("\n\n"),
          testSuggestion: `Cover: a real object with \`${attr}\` (normal case), \`None\` as the value (the bug), and a missing/empty value.`,
        },
      };
    } else if (objAttr) {
      const typeName = objAttr[1], attr = objAttr[2];
      evidence.push(`\`${typeName}\` objects do not have a \`${attr}\` attribute in Python's standard library.`);
      const attrLine = lines.find((l) => new RegExp(`\\.${escapeRegExp(attr)}\\b`).test(l.text));
      if (attrLine) evidence.push(`Line ${attrLine.n} (\`${pyTrunc(attrLine.text)}\`) accesses \`.${attr}\`.`);
      if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\`.`);
      rootCause = `The object has type \`${typeName}\`, which does not have \`${attr}\`. Either the object is the wrong type, the attribute name is misspelled, or a different method achieves the same goal.`;
      confidence = "Medium";
    } else {
      evidence.push(`\`AttributeError\` means the object does not have the attribute or method being accessed.`);
      if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\`.`);
      rootCause = `An attribute or method was accessed on an object that does not have it. This can happen if the object is the wrong type, is \`None\`, or the attribute name is misspelled.`;
    }
    return {
      plan: { kind: "generic", fnName: frame?.fn },
      result: {
        problem: `AttributeError: ${pyTrunc(detail, 120)}`,
        rootCause,
        evidence,
        confidence,
        suggestedFix: `Check the type of the object with \`type(obj)\` or \`print(obj)\` before the failing line. Make sure it is the expected type and is not \`None\`. Use \`dir(obj)\` to see what attributes it actually has.`,
        testSuggestion: `Cover: the correct object type (normal case), \`None\`, and a wrong-type value.`,
      },
    };
  }

  // ── P6: ZeroDivisionError ─────────────────────────────────────────────────
  if (/\bZeroDivisionError\b/.test(combined)) {
    const evidence: string[] = [`The error message reads: \`${pyTrunc(headline)}\`.`];
    evidence.push(`\`ZeroDivisionError\` is raised when code divides by zero or takes the modulo of zero.`);
    const divLine = lines.find((l) => /\/\s*0\b|\/\s*\w+/.test(l.text) && !/\/\//.test(l.text.slice(0, l.text.search(/\//))));
    const actualDivLine = lines.find((l) => /\s*\/\s*|\s*%\s*/.test(l.text) && !/def |class |import /.test(l.text));
    const target = divLine ?? actualDivLine;
    if (target) evidence.push(`Line ${target.n} (\`${pyTrunc(target.text)}\`) performs a division or modulo operation.`);
    if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\`.`);
    return {
      plan: { kind: "generic", fnName: frame?.fn },
      result: {
        problem: `Division by zero.`,
        rootCause: target
          ? `Line ${target.n} divides by a value that is zero at runtime. The divisor must be validated before the operation.`
          : `A division or modulo operation has a zero divisor. Find the expression being divided by and validate it before use.`,
        evidence,
        confidence: target ? "High" : "Medium",
        suggestedFix: [
          target
            ? `Add a guard before line ${target.n}: \`if divisor != 0: result = numerator / divisor\`.`
            : `Add a guard before every division: \`if denominator != 0:\`.`,
          `Or raise a descriptive error: \`if denominator == 0: raise ValueError("denominator must not be zero")\`.`,
          `Why it works: the division is only attempted when the divisor is non-zero.`,
        ].join("\n\n"),
        testSuggestion: `Cover: a non-zero divisor (normal case), a zero divisor (the bug), and a negative divisor.`,
      },
    };
  }

  // ── P7: ValueError ────────────────────────────────────────────────────────
  const valErr = /\bValueError\b:\s*(.+)/.exec(combined);
  if (valErr) {
    const detail = valErr[1].trim();
    const evidence: string[] = [`The error message reads: \`${pyTrunc(headline)}\`.`];
    evidence.push(`\`ValueError\` means a function received an argument of the right type but an invalid value (e.g. converting a non-numeric string to \`int\`, or using an invalid format string).`);
    const intConvM = /invalid literal for int\(\) with base \d+: '([^']+)'/.exec(detail);
    const notEnoughM = /not enough values to unpack/.test(detail);
    let rootCause: string;
    let confidence: Confidence = "Medium";
    if (intConvM) {
      const badVal = intConvM[1];
      evidence.push(`\`int("${badVal}")\` fails because \`"${badVal}"\` cannot be parsed as an integer.`);
      const intLine = lines.find((l) => /\bint\s*\(/.test(l.text));
      if (intLine) evidence.push(`Line ${intLine.n} (\`${pyTrunc(intLine.text)}\`) converts a value to \`int\`.`);
      if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\`.`);
      rootCause = `\`int("${badVal}")\` cannot parse \`"${badVal}"\` as a number. The input contains non-numeric characters.`;
      confidence = "High";
    } else if (notEnoughM) {
      evidence.push(`"Not enough values to unpack" means a tuple/list destructuring expected more values than were provided.`);
      const unpackLine = lines.find((l) => /\s*=\s*\w+\s*$/.test(l.text) && /,/.test(l.text.split("=")[0]));
      if (unpackLine) evidence.push(`Line ${unpackLine.n} (\`${pyTrunc(unpackLine.text)}\`) unpacks a sequence.`);
      if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\`.`);
      rootCause = `A destructuring assignment expected more elements than the sequence contains.`;
    } else {
      if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\`.`);
      rootCause = `A function received a value of the correct type but an invalid content: ${pyTrunc(detail, 100)}.`;
    }
    return {
      plan: { kind: "generic", fnName: frame?.fn },
      result: {
        problem: `ValueError: ${pyTrunc(detail, 120)}`,
        rootCause,
        evidence,
        confidence,
        suggestedFix: intConvM
          ? `Validate the string before converting: \`if value.isdigit(): n = int(value)\`, or wrap in try/except: \`try: n = int(value)\nexcept ValueError: # handle bad input\`.`
          : notEnoughM
            ? `Check the number of elements in the sequence before unpacking, or use \`*rest\` to absorb extra/fewer items: \`a, *rest = sequence\`.`
            : `Validate the value before passing it to the function. Add a try/except to catch \`ValueError\` and provide a meaningful error message.`,
        testSuggestion: `Cover: a valid value (normal case), the invalid value that caused the error, and an edge case (empty string, zero, etc.).`,
      },
    };
  }

  return null;
}

// ===========================================================================
// Java analyzer — rule-based, partial support
// ===========================================================================

function lastJavaFrame(text: string): { cls: string; method: string; file: string; line: number } | null {
  const matches = [...text.matchAll(/at\s+([\w$.]+)\.([\w$<>]+)\(([\w$.]+\.java):(\d+)\)/g)];
  if (matches.length === 0) return null;
  const last = matches[0]; // first = most recent in Java
  return { cls: last[1], method: last[2], file: last[3], line: Number(last[4]) };
}

type JavaLine = { n: number; text: string };
function toJavaLines(code: string): JavaLine[] {
  return code.split("\n").map((text, i) => ({ n: i + 1, text }));
}

function javaTrunc(s: string, max = 70): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function analyzeJava(input: InvestigationInput, combined: string): Analysis | null {
  const headline = firstLine(input.error);
  const lines = toJavaLines(input.code);
  const frame = lastJavaFrame(combined);

  // ── J1: NullPointerException ──────────────────────────────────────────────
  if (/\bNullPointerException\b/.test(combined)) {
    const evidence: string[] = [`The error message reads: \`${javaTrunc(headline)}\`.`];
    // Java 14+ NPE messages include the null reference name.
    const npeDetail = /Cannot (invoke|read field) "([^"]+)" because "([^"]+)" is null/.exec(combined);
    if (npeDetail) {
      evidence.push(`Java 14+ NPE message: cannot access \`${npeDetail[2]}\` because \`${npeDetail[3]}\` is null.`);
    }
    const dotLine = frame ? lines.find((l) => l.n === frame.line) : undefined;
    if (dotLine) evidence.push(`Line ${dotLine.n} (\`${javaTrunc(dotLine.text)}\`) is the failing call.`);
    if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\` in \`${frame.cls}.${frame.method}\`.`);
    // Look for null checks around the failing line.
    const nullCheckPresent = frame ? lines
      .filter((l) => l.n < (frame.line) && l.n > Math.max(1, frame.line - 10))
      .some((l) => /!=\s*null|==\s*null|\bObjects\.requireNonNull\b|\bOptional\b/.test(l.text)) : false;
    if (!nullCheckPresent && dotLine) {
      evidence.push(`No null check was found before line ${frame?.line ?? dotLine.n} in the pasted code.`);
    }
    return {
      plan: { kind: "generic", fnName: frame?.method },
      result: {
        problem: npeDetail
          ? `\`${npeDetail[3]}\` is null when \`${npeDetail[2]}\` is accessed.`
          : `A \`NullPointerException\` was thrown — a null reference was dereferenced.`,
        rootCause: npeDetail
          ? `\`${npeDetail[3]}\` is null at the point where \`${npeDetail[2]}\` is accessed. The object was either never initialised, or a method returned null that was not checked.`
          : dotLine
            ? `Line ${dotLine.n} calls a method or accesses a field on a variable that is null. Java throws \`NullPointerException\` whenever you dereference a null reference.`
            : `A null reference is being dereferenced. Find where the variable was assigned and check that it is always initialised to a non-null value.`,
        evidence,
        confidence: (npeDetail || dotLine) ? "High" : "Medium",
        suggestedFix: [
          dotLine
            ? `Add a null check before line ${dotLine.n}: \`if (obj != null) { ... }\` or use \`Objects.requireNonNull(obj, "description")\` to fail fast with a clear message.`
            : `Check every variable that could be null at the failing location. Use null checks, \`Optional<T>\`, or \`Objects.requireNonNull()\`.`,
          `Java 8+: consider returning \`Optional<T>\` from methods that may not produce a value instead of returning \`null\`.`,
          `Why it works: the operation is only performed when the reference is confirmed non-null.`,
        ].join("\n\n"),
        testSuggestion: `Cover: a properly initialised object (normal case), a null value (the bug), and the boundary where the object might be null.`,
      },
    };
  }

  // ── J2: ArrayIndexOutOfBoundsException ────────────────────────────────────
  const aioob = /\bArrayIndexOutOfBoundsException\b.*?(\d+)/.exec(combined);
  if (aioob || /\bArrayIndexOutOfBoundsException\b/.test(combined)) {
    const badIndex = aioob?.[1];
    const evidence: string[] = [`The error message reads: \`${javaTrunc(headline)}\`.`];
    if (badIndex) evidence.push(`The index \`${badIndex}\` is out of range for the array.`);
    evidence.push(`\`ArrayIndexOutOfBoundsException\` is thrown when you access an array at an index that is negative or ≥ the array's length.`);
    const arrLine = frame ? lines.find((l) => l.n === frame.line) : lines.find((l) => /\[\s*[\w\-+*/]+\s*\]/.test(l.text));
    if (arrLine) evidence.push(`Line ${arrLine.n} (\`${javaTrunc(arrLine.text)}\`) accesses an array by index.`);
    if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\` in \`${frame.cls}.${frame.method}\`.`);
    return {
      plan: { kind: "generic", fnName: frame?.method },
      result: {
        problem: `An array was accessed at an index that is out of range${badIndex ? ` (index ${badIndex})` : ""}.`,
        rootCause: arrLine
          ? `Line ${arrLine.n} accesses an array element at an index that does not exist. Either the array is shorter than expected, or the index calculation is incorrect.`
          : `An array is accessed at an invalid index. Check that the index is non-negative and less than the array's \`.length\`.`,
        evidence,
        confidence: arrLine ? "High" : "Medium",
        suggestedFix: [
          `Before the array access, add a bounds check: \`if (index >= 0 && index < arr.length)\`.`,
          `If iterating, use a for-each loop: \`for (Type item : arr)\` — this never goes out of bounds.`,
          `Why it works: the access is only performed when the index is within the valid range.`,
        ].join("\n\n"),
        testSuggestion: `Cover: a valid index (normal case), an index equal to \`length\` (one past the end — the bug), and an empty array.`,
      },
    };
  }

  // ── J3: NumberFormatException ─────────────────────────────────────────────
  const numFmt = /\bNumberFormatException\b.*?(?:For input string:\s*"([^"]*)")?/.exec(combined);
  if (numFmt) {
    const badInput = numFmt[1];
    const evidence: string[] = [`The error message reads: \`${javaTrunc(headline)}\`.`];
    if (badInput !== undefined) evidence.push(`The string \`"${badInput}"\` cannot be parsed as a number.`);
    evidence.push(`\`NumberFormatException\` is thrown by \`Integer.parseInt()\`, \`Double.parseDouble()\`, etc. when the string does not represent a valid number.`);
    const parseLine = lines.find((l) => /\bparseInt\b|\bparseDouble\b|\bparseLong\b|\bparseFloat\b/.test(l.text));
    if (parseLine) evidence.push(`Line ${parseLine.n} (\`${javaTrunc(parseLine.text)}\`) parses a string as a number.`);
    if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\`.`);
    return {
      plan: { kind: "generic", fnName: frame?.method },
      result: {
        problem: `A string${badInput !== undefined ? ` (\`"${badInput}"\`)` : ""} could not be parsed as a number.`,
        rootCause: parseLine
          ? `Line ${parseLine.n} calls a parse method on a string that does not contain a valid numeric value. When the string contains non-numeric characters${badInput !== undefined ? ` (like \`"${badInput}"\`)` : ""}, Java throws \`NumberFormatException\`.`
          : `A parse method (\`parseInt\`, \`parseDouble\`, etc.) received a string that is not a valid number. Validate the string before parsing.`,
        evidence,
        confidence: (parseLine || badInput !== undefined) ? "High" : "Medium",
        suggestedFix: [
          `Wrap the parse call in a try/catch: \`try { int n = Integer.parseInt(s); } catch (NumberFormatException e) { /* handle */ }\`.`,
          `Or validate first: check that the string matches \`\\d+\` (or a suitable pattern) before parsing.`,
          `Why it works: the exception is caught so the program can handle bad input gracefully.`,
        ].join("\n\n"),
        testSuggestion: `Cover: a valid numeric string (normal case), a non-numeric string (the bug), an empty string, and \`null\`.`,
      },
    };
  }

  // ── J4: ArithmeticException (/ by zero) ───────────────────────────────────
  if (/\bArithmeticException\b.*?(?:\/\s*by\s*zero|divide by zero)/i.test(combined) || /\bArithmeticException\b/.test(combined)) {
    const evidence: string[] = [`The error message reads: \`${javaTrunc(headline)}\`.`];
    evidence.push(`\`ArithmeticException: / by zero\` is thrown when integer division or modulo is performed with a zero divisor in Java.`);
    const divLine = frame ? lines.find((l) => l.n === frame.line) : lines.find((l) => /[/%]\s*\w+/.test(l.text) && !/\/\//.test(l.text));
    if (divLine) evidence.push(`Line ${divLine.n} (\`${javaTrunc(divLine.text)}\`) performs a division or modulo operation.`);
    if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\`.`);
    return {
      plan: { kind: "generic", fnName: frame?.method },
      result: {
        problem: `Integer division or modulo by zero.`,
        rootCause: divLine
          ? `Line ${divLine.n} divides by a value that is zero at runtime. Note: Java only throws \`ArithmeticException\` for integer division — floating-point division by zero produces \`Infinity\` without throwing.`
          : `A division or modulo operation has a zero divisor. Add a guard before the operation.`,
        evidence,
        confidence: divLine ? "High" : "Medium",
        suggestedFix: [
          divLine
            ? `Add a guard before line ${divLine.n}: \`if (divisor != 0) { result = numerator / divisor; } else { /* handle zero case */ }\`.`
            : `Add a guard before every integer division: check the divisor is not zero before dividing.`,
          `Why it works: the division is only attempted when the divisor is non-zero.`,
        ].join("\n\n"),
        testSuggestion: `Cover: a non-zero divisor (normal case), a zero divisor (the bug), and a negative divisor.`,
      },
    };
  }

  // ── J5: ClassCastException ────────────────────────────────────────────────
  const classCast = /\bClassCastException\b.*?class\s+([\w$.]+)\s+cannot be cast to class\s+([\w$.]+)/i.exec(combined)
    ?? /\bClassCastException\b.*?([\w$.]+)\s+cannot be cast to\s+([\w$.]+)/i.exec(combined);
  if (classCast || /\bClassCastException\b/.test(combined)) {
    const fromType = classCast?.[1] ?? "unknown";
    const toType = classCast?.[2] ?? "unknown";
    const evidence: string[] = [`The error message reads: \`${javaTrunc(headline)}\`.`];
    if (classCast) evidence.push(`Java cannot cast \`${fromType}\` to \`${toType}\` — these types are incompatible.`);
    evidence.push(`\`ClassCastException\` is thrown when you explicitly cast an object to a type it is not.`);
    const castLine = frame ? lines.find((l) => l.n === frame.line) : lines.find((l) => /\([A-Z][\w.]*\)\s*\w+/.test(l.text));
    if (castLine) evidence.push(`Line ${castLine.n} (\`${javaTrunc(castLine.text)}\`) performs a cast.`);
    if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}\`.`);
    return {
      plan: { kind: "generic", fnName: frame?.method },
      result: {
        problem: classCast
          ? `\`${fromType}\` cannot be cast to \`${toType}\`.`
          : `An object was cast to a type it is not an instance of.`,
        rootCause: classCast
          ? `The object's actual runtime type is \`${fromType}\`, which is not a subtype of \`${toType}\`. Explicit casts only work when the object is actually an instance of the target type.`
          : `A cast was attempted on an object whose runtime type is incompatible with the target type.`,
        evidence,
        confidence: (classCast || castLine) ? "High" : "Medium",
        suggestedFix: [
          castLine
            ? `Before line ${castLine.n}, check the type with \`instanceof\`: \`if (obj instanceof TargetType t) { /* safe to use t */ }\` (Java 16+ pattern matching) or \`if (obj instanceof TargetType) { TargetType t = (TargetType) obj; }\`.`
            : `Check the object's runtime type with \`instanceof\` before casting. Use generics to avoid casts altogether when possible.`,
          `Why it works: the cast is only performed when the runtime type is confirmed to match.`,
        ].join("\n\n"),
        testSuggestion: `Cover: an object of the correct type (normal case), an object of the wrong type (the bug), and \`null\`.`,
      },
    };
  }

  return null;
}

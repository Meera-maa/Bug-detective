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
  const declared = lines.find((l) => new RegExp(`\\b(?:const|let|var|function|class|import)\\b[^;\\n]*\\b${n}\\b`).test(l.text) || new RegExp(`\\(([^)]*\\b${n}\\b[^)]*)\\)\\s*(?:=>|\\{)`).test(l.text));
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
// Fallback: honest low-confidence answer
// ---------------------------------------------------------------------------

function analyzeGeneric(input: InvestigationInput, combined: string, isJsLike: boolean): Analysis {
  const lines = toLines(input.code);
  const headline = firstLine(input.error);
  const frame = parseStackFrame(input.stackTrace ?? combined);
  const kind = /^\s*([A-Za-z]*(?:Error|Exception))\b/.exec(headline)?.[1];
  const status = /\b([45]\d{2})\b/.exec(headline)?.[1];

  const evidence: string[] = [`The error message reads: \`${truncate(headline, 90)}\`.`];
  if (kind) evidence.push(`The error type is \`${kind}\`.`);
  if (status) evidence.push(`The status code \`${status}\` was reported${status.startsWith("5") ? ", which usually means the failure happened on the server, not in the calling code" : ", which usually means the request itself was rejected"}.`);
  if (frame) evidence.push(`The stack trace points to \`${frame.file}:${frame.line}:${frame.col}\`${frame.fn ? ` in \`${frame.fn}\`` : ""}.`);

  // Only quote code lines that mention identifiers found in the error text.
  const words = Array.from(new Set(headline.match(/['"`]([A-Za-z_$][\w$.]*)['"`]/g)?.map((w) => w.slice(1, -1)) ?? []));
  for (const w of words.slice(0, 2)) {
    const hit = lines.find((l) => new RegExp(`\\b${escapeRegExp(w)}\\b`).test(l.text));
    if (hit) evidence.push(`\`${w}\` from the error appears on line ${hit.n}: \`${truncate(hit.text)}\`.`);
  }
  evidence.push(
    isJsLike
      ? "The built-in analyzer did not recognise this as one of its known patterns, so it cannot name a root cause."
      : `The built-in analyzer only understands JavaScript and TypeScript patterns, so it cannot analyse ${input.language} code. IBM Bob is meant to cover this.`,
  );

  const fnName = findEnclosingFunction(lines, lines.length)?.name;
  return {
    plan: { kind: "generic", fnName },
    result: {
      problem: truncate(headline, 140) || "An error was reported.",
      rootCause:
        "No confident root cause could be identified from this input. The clues below narrow where to look, but they do not prove a cause.",
      evidence,
      confidence: "Low",
      suggestedFix: [
        "Work through these steps to narrow it down:",
        "- Log the values used on the line named in the stack trace, right before it runs.",
        "- Check which of those values can be missing, empty or a different type than the code assumes.",
        "- Paste a smaller piece of code, the full stack trace, or the data involved for a sharper analysis.",
      ].join("\n"),
      testSuggestion:
        "Once the cause is known, write a test that reproduces the failing input first, then confirm it passes after the fix.",
    },
  };
}

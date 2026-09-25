import { describe, expect, it } from "vitest";
import { analyze } from "@/lib/ai/mock/analyzer";
import { buildTest } from "@/lib/ai/mock/tests";
import { DEMOS } from "@/lib/demos";
import { runSync } from "@/lib/runner/harness";
import { parseGeneratedTest, parseInvestigationResult } from "@/lib/validate";

describe.each(DEMOS)("demo: $title", (demo) => {
  const { result, plan } = analyze(demo.input);

  it("produces a valid structured result with evidence taken from the input", () => {
    const parsed = parseInvestigationResult(result);
    expect(parsed.ok).toBe(true);
    expect(result.evidence.length).toBeGreaterThanOrEqual(3);
    expect(result.fixedCode).toBeTruthy();
    expect(result.confidence).toBe("High");
    // Every backticked code snippet in the evidence that quotes a "Line N" must exist in the pasted code.
    for (const e of result.evidence) {
      const m = /Line (\d+) \(`(.+?)`\)/.exec(e);
      if (m) {
        const line = demo.input.code.split("\n")[Number(m[1]) - 1] ?? "";
        expect(line.trim().startsWith(m[2].replace(/…$/, "").trim())).toBe(true);
      }
    }
  });

  it("generates a valid test", () => {
    const test = buildTest(demo.input, result, plan);
    expect(parseGeneratedTest(test).ok).toBe(true);
    expect(test.code).toContain("describe(");
  });

  it("test FAILS on the original code and PASSES on the suggested fix (real execution)", () => {
    const test = buildTest(demo.input, result, plan);
    const before = runSync(demo.input.code, test.code);
    const after = runSync(result.fixedCode ?? "", test.code);
    expect(before.ok && before.results.some((r) => !r.passed)).toBe(true);
    expect(after.ok).toBe(true);
    if (after.ok) {
      const failed = after.results.filter((r) => !r.passed);
      expect(failed, JSON.stringify(failed)).toEqual([]);
      expect(after.results.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("robustness", () => {
  it("does not claim a root cause for unknown errors", () => {
    const { result } = analyze({ language: "JavaScript", error: "Error: something odd happened", code: "const a = 1;" });
    expect(result.confidence).toBe("Low");
    expect(result.fixedCode).toBeUndefined();
    expect(parseInvestigationResult(result).ok).toBe(true);
  });

  it("is honest about unsupported languages", () => {
    const { result } = analyze({ language: "Python", error: "AttributeError: 'NoneType' object has no attribute 'name'", code: "print(user.name)" });
    expect(result.confidence).toBe("Low");
    expect(result.evidence.join(" ")).toContain("only understands JavaScript and TypeScript");
  });

  it("handles a ReferenceError", () => {
    const { result } = analyze({ language: "JavaScript", error: "ReferenceError: total is not defined", code: "function f() {\n  return total + 1;\n}" });
    expect(result.problem).toContain("total");
    expect(result.confidence).toBe("High");
  });

  it("rejects malformed AI responses", () => {
    expect(parseInvestigationResult(null).ok).toBe(false);
    expect(parseInvestigationResult({ problem: "x" }).ok).toBe(false);
    expect(parseInvestigationResult({ problem: "a", rootCause: "b", evidence: [], confidence: "High", suggestedFix: "c", testSuggestion: "d" }).ok).toBe(false);
    expect(parseInvestigationResult({ problem: "a", rootCause: "b", evidence: ["e"], confidence: "Certain", suggestedFix: "c", testSuggestion: "d" }).ok).toBe(false);
  });

  it("runner reports thrown errors in test code instead of crashing", () => {
    const r = runSync("function f() {", "describe('x', () => {});");
    expect(r.ok).toBe(false);
  });
});

import { diffLines } from "@/lib/diff";
describe("diff", () => {
  it("marks added and removed lines", () => {
    const d = diffLines("a\nb\nc", "a\nx\nc")!;
    expect(d.map((l) => l.type)).toEqual(["same", "remove", "add", "same"]);
  });
});

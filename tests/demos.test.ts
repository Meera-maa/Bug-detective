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

// ---------------------------------------------------------------------------
// New pattern tests — each covers a bug type beyond the three demo bugs
// ---------------------------------------------------------------------------

describe("pattern: SyntaxError — missing closing brace", () => {
  const input = {
    language: "JavaScript" as const,
    error: "SyntaxError: Unexpected end of input",
    stackTrace: "    at Object.<anonymous> (app.js:5:1)",
    code: `function greet(name) {
  if (name) {
    return "Hello " + name;
  // missing closing brace for function
`,
  };
  const { result, plan } = analyze(input);

  it("recognises the SyntaxError pattern", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem).toContain("SyntaxError");
    // Brace imbalance detected: 2 open { vs 1 close }
    expect(result.evidence.some((e) => /brace/i.test(e))).toBe(true);
  });

  it("produces Medium or Low confidence (never invented High)", () => {
    expect(["Medium", "Low"]).toContain(result.confidence);
  });

  it("generates a valid test", () => {
    expect(parseGeneratedTest(buildTest(input, result, plan)).ok).toBe(true);
  });

  it("does not invent a fixedCode for a SyntaxError (cannot safely rewrite unparseable code)", () => {
    expect(result.fixedCode).toBeUndefined();
  });
});

describe("pattern: RangeError — infinite recursion / stack overflow", () => {
  const input = {
    language: "JavaScript" as const,
    error: "RangeError: Maximum call stack size exceeded",
    stackTrace: "    at countdown (math.js:2:3)\n    at countdown (math.js:2:3)\n    at countdown (math.js:2:3)",
    code: `function countdown(n) {
  return countdown(n - 1);
}`,
  };
  const { result, plan } = analyze(input);

  it("identifies the self-call", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem).toContain("countdown");
    expect(result.evidence.some((e) => /calls itself/i.test(e) || /line 2/i.test(e))).toBe(true);
  });

  it("reports High confidence when the self-call has no guard", () => {
    expect(result.confidence).toBe("High");
  });

  it("generates a valid test with stack-overflow plan", () => {
    expect(plan.kind).toBe("stack-overflow");
    expect(parseGeneratedTest(buildTest(input, result, plan)).ok).toBe(true);
  });
});

describe("pattern: RangeError — Invalid array length", () => {
  const input = {
    language: "JavaScript" as const,
    error: "RangeError: Invalid array length",
    stackTrace: "    at buildBuffer (utils.js:2:18)",
    code: `function buildBuffer(size) {
  return new Array(size);
}`,
  };
  const { result, plan } = analyze(input);

  it("identifies the invalid array length pattern", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem).toMatch(/array.*invalid length|invalid.*array length/i);
    expect(result.evidence.some((e) => /new Array/i.test(e) || /line 2/i.test(e))).toBe(true);
  });

  it("generates a valid test", () => {
    expect(parseGeneratedTest(buildTest(input, result, plan)).ok).toBe(true);
  });
});

describe("pattern: X is not a function", () => {
  const input = {
    language: "JavaScript" as const,
    error: "TypeError: transform is not a function",
    stackTrace: "    at process (pipeline.js:3:12)",
    code: `function process(data, transform) {
  const cleaned = data.trim();
  return transform(cleaned);
}`,
  };
  const { result, plan } = analyze(input);

  it("identifies the not-a-function pattern", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem).toContain("transform");
    expect(result.evidence.some((e) => /transform/i.test(e))).toBe(true);
  });

  it("reports Medium or High confidence", () => {
    expect(["Medium", "High"]).toContain(result.confidence);
  });

  it("uses the not-a-function plan kind", () => {
    expect(plan.kind).toBe("not-a-function");
    if (plan.kind === "not-a-function") expect(plan.callee).toBe("transform");
  });

  it("generates a valid test", () => {
    expect(parseGeneratedTest(buildTest(input, result, plan)).ok).toBe(true);
  });
});

describe("pattern: async/await forgotten — then is not a function", () => {
  const input = {
    language: "JavaScript" as const,
    error: "TypeError: result.then is not a function",
    stackTrace: "    at loadUser (api.js:4:10)",
    code: `async function fetchUser(id) {
  return { id, name: "Meera" };
}

function loadUser(id) {
  const result = fetchUser(id);
  return result.then(u => u.name);
}`,
  };
  const { result, plan } = analyze(input);

  it("identifies the async/await pattern", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    // Should mention await or Promise
    expect(
      result.problem.toLowerCase().includes("await") ||
      result.problem.toLowerCase().includes("promise") ||
      result.rootCause.toLowerCase().includes("async") ||
      result.evidence.some((e) => /await|promise|async/i.test(e))
    ).toBe(true);
  });

  it("generates a valid test", () => {
    expect(parseGeneratedTest(buildTest(input, result, plan)).ok).toBe(true);
  });
});

describe("pattern: missing return — caller reads property on undefined", () => {
  const input = {
    language: "JavaScript" as const,
    error: "TypeError: Cannot read properties of undefined (reading 'id')",
    stackTrace: "    at handler (server.js:8:22)",
    code: `function createUser(name) {
  if (!name) {
    return;
  }
  const user = { id: 1, name };
  return user;
}

function handler(name) {
  return createUser(name).id;
}`,
  };
  const { result, plan } = analyze(input);

  it("identifies the missing-return / bare-return pattern", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    // Should mention createUser and the bare return
    expect(result.evidence.some((e) => /createUser|bare.*return|return;/i.test(e))).toBe(true);
  });

  it("reports Medium confidence", () => {
    expect(result.confidence).toBe("Medium");
  });

  it("generates a valid test", () => {
    expect(parseGeneratedTest(buildTest(input, result, plan)).ok).toBe(true);
  });
});

describe("pattern: X is not iterable", () => {
  const input = {
    language: "JavaScript" as const,
    error: "TypeError: items is not iterable",
    stackTrace: "    at sumAll (calc.js:2:22)",
    code: `function sumAll(items) {
  return [...items].reduce((a, b) => a + b, 0);
}`,
  };
  const { result, plan } = analyze(input);

  it("identifies the not-iterable pattern", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem).toContain("items");
    expect(result.evidence.some((e) => /items/i.test(e))).toBe(true);
  });

  it("generates a valid test", () => {
    expect(parseGeneratedTest(buildTest(input, result, plan)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests for the 6 required new bug categories
// ---------------------------------------------------------------------------

describe("category: invalid JSON / HTML response from server", () => {
  const input = {
    language: "JavaScript" as const,
    error: `SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
    code: `async function loadUsers() {
  const response = await fetch("/api/users");
  const data = await response.json();
  return data.users;
}`,
  };
  const { result } = analyze(input);

  it("identifies the HTML-instead-of-JSON cause", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem).toMatch(/html|json/i);
    expect(result.rootCause.toLowerCase()).toMatch(/html|<!doctype|server/);
  });

  it("reports High confidence", () => {
    expect(result.confidence).toBe("High");
  });

  it("quotes the fetch/json line as evidence", () => {
    expect(result.evidence.some((e) => /response\.json|fetch/i.test(e))).toBe(true);
  });

  it("explains what '<' means (first byte of HTML)", () => {
    expect(result.evidence.some((e) => /</.test(e) || /HTML/i.test(e))).toBe(true);
  });

  it("suggests checking response.ok before parsing", () => {
    expect(result.suggestedFix.toLowerCase()).toMatch(/response\.ok|status|2xx/i);
  });

  it("provides a fixedCode that guards response.ok", () => {
    expect(result.fixedCode).toBeTruthy();
    expect(result.fixedCode).toContain("response.ok");
  });
});

describe("category: .filter() called on a plain object (Array method on non-array)", () => {
  const input = {
    language: "JavaScript" as const,
    error: "TypeError: users.filter is not a function",
    code: `function getActiveUsers(users) {
  return users.filter(user => user.active);
}

const users = {
  name: "Meera",
  active: true
};

console.log(getActiveUsers(users));`,
  };
  const { result } = analyze(input);

  it("identifies that users is an object, not an array", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem).toMatch(/object|filter/i);
    expect(result.rootCause.toLowerCase()).toMatch(/object|array/);
  });

  it("reports Medium or High confidence", () => {
    expect(["Medium", "High"]).toContain(result.confidence);
  });

  it("explains that .filter is an Array method", () => {
    expect(
      result.evidence.some((e) => /Array\.prototype\.filter|array.*method|only works on array/i.test(e))
    ).toBe(true);
  });

  it("points to the object literal declaration as evidence", () => {
    expect(result.evidence.some((e) => /plain object|object.*line|line.*object/i.test(e))).toBe(true);
  });

  it("suggests Object.values() as a fix", () => {
    expect(result.suggestedFix).toContain("Object.values");
  });
});

describe("category: network / fetch failure — CORS", () => {
  const input = {
    language: "JavaScript" as const,
    error: "TypeError: Failed to fetch\nAccess to fetch at 'https://api.example.com/data' from origin 'http://localhost:3000' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.",
    code: `async function getData() {
  const response = await fetch("https://api.example.com/data");
  return response.json();
}`,
  };
  const { result } = analyze(input);

  it("identifies the CORS error", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem.toLowerCase()).toMatch(/cors|browser blocked/i);
    expect(result.rootCause.toLowerCase()).toMatch(/cors|access-control/i);
  });

  it("reports High confidence for CORS", () => {
    expect(result.confidence).toBe("High");
  });

  it("explains what CORS is and where the fix must be", () => {
    expect(result.evidence.some((e) => /Access-Control-Allow-Origin|server/i.test(e))).toBe(true);
    expect(result.suggestedFix.toLowerCase()).toMatch(/server|header/i);
  });

  it("points to the fetch line as evidence", () => {
    expect(result.evidence.some((e) => /fetch|line 2/i.test(e))).toBe(true);
  });
});

describe("category: network / fetch failure — connection refused", () => {
  const input = {
    language: "JavaScript" as const,
    error: "TypeError: Failed to fetch\nnet::ERR_CONNECTION_REFUSED",
    code: `async function ping() {
  const res = await fetch("http://localhost:8080/health");
  return res.json();
}`,
  };
  const { result } = analyze(input);

  it("identifies the connection-refused cause", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.rootCause.toLowerCase()).toMatch(/refused|not running|server/i);
  });

  it("reports High confidence", () => {
    expect(result.confidence).toBe("High");
  });
});

describe("category: promise rejection — unhandled", () => {
  const input = {
    language: "JavaScript" as const,
    error: "UnhandledPromiseRejectionWarning: Error: Database connection failed",
    code: `async function saveRecord(data) {
  const result = await db.insert(data);
  return result.id;
}

saveRecord({ name: "Meera" });`,
  };
  const { result } = analyze(input);

  it("identifies the unhandled rejection", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem.toLowerCase()).toMatch(/rejected|rejection|promise/i);
    expect(result.rootCause.toLowerCase()).toMatch(/catch|handler|rejected/i);
  });

  it("reports High confidence", () => {
    expect(result.confidence).toBe("High");
  });

  it("includes evidence about the inner error", () => {
    expect(result.evidence.some((e) => /Database connection failed/i.test(e))).toBe(true);
  });

  it("recommends try/catch or .catch()", () => {
    expect(result.suggestedFix.toLowerCase()).toMatch(/try.*catch|\.catch/i);
  });
});

describe("category: logic / NaN propagation", () => {
  const input = {
    language: "JavaScript" as const,
    error: "Error: Expected a valid price, got NaN",
    code: `function calculateTotal(price, quantity) {
  const total = parseInt(price) * quantity;
  return total;
}`,
  };
  const { result } = analyze(input);

  it("identifies the NaN logic error", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.evidence.some((e) => /NaN|numeric|parseInt/i.test(e))).toBe(true);
    expect(result.rootCause.toLowerCase()).toMatch(/nan|numeric|number/i);
  });

  it("points to parseInt as a possible NaN source", () => {
    expect(result.evidence.some((e) => /parseInt|line \d/i.test(e))).toBe(true);
  });

  it("recommends validating numeric inputs", () => {
    expect(result.suggestedFix.toLowerCase()).toMatch(/nan|number\.isnan|validate/i);
  });
});

describe("category: off-by-one (arr[arr.length])", () => {
  const input = {
    language: "JavaScript" as const,
    error: "Error: last item is undefined",
    code: `function getLastItem(arr) {
  return arr[arr.length];
}`,
  };
  const { result } = analyze(input);

  it("detects the off-by-one array access", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.evidence.some((e) => /arr\.length|length.*index|off.by.one|length - 1/i.test(e))).toBe(true);
  });

  it("suggests arr[arr.length - 1]", () => {
    expect(result.suggestedFix).toContain("length - 1");
  });
});

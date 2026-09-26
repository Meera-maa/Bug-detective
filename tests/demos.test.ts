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

  it("is honest about Other/unsupported languages", () => {
    const { result } = analyze({ language: "Other", error: "Some unknown error", code: "x = 1" });
    expect(result.confidence).toBe("Low");
    expect(parseInvestigationResult(result).ok).toBe(true);
  });

  it("handles Python AttributeError (NoneType) with real analysis", () => {
    const { result } = analyze({ language: "Python", error: "AttributeError: 'NoneType' object has no attribute 'name'", code: "print(user.name)" });
    // Python is now partially supported — should not say "only understands JavaScript and TypeScript"
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.confidence).not.toBe("Low"); // should be Medium or High
    expect(result.evidence.some((e) => /None|NoneType|attribute/i.test(e))).toBe(true);
  });

  it("reports High confidence when an undefined argument causes a direct parameter property read", () => {
    const { result } = analyze({
      language: "JavaScript",
      error: "TypeError: Cannot read properties of undefined (reading 'name')",
      code: `function getUserName(user) {
  return user.name;
}

const userName = getUserName(undefined);
console.log(userName);`,
    });

    expect(result.confidence).toBe("High");
    expect(result.evidence.some((entry) => /explicit `undefined` argument/.test(entry))).toBe(true);
  });

  it("keeps parameter-only undefined-property analysis at Medium without caller evidence", () => {
    const { result } = analyze({
      language: "JavaScript",
      error: "TypeError: Cannot read properties of undefined (reading 'name')",
      code: "function getUserName(user) {\n  return user.name;\n}",
    });

    expect(result.confidence).toBe("Medium");
  });

  it.each([
    {
      language: "Python" as const,
      error: "RuntimeError: unexpected failure",
      stackTrace: 'Traceback (most recent call last):\n  File "app.py", line 2, in calculate\n    return value + 1',
      code: "def calculate(value):\n    return value + 1",
    },
    {
      language: "Java" as const,
      error: "IllegalStateException: unexpected failure",
      stackTrace: "at Example.calculate(Example.java:3)",
      code: "class Example {\n    int calculate(int value) {\n        return value + 1;\n    }\n}",
    },
  ])("uses a language stack frame to locate an unrecognised $language error", (input) => {
    const { result } = analyze(input);
    expect(result.confidence).toBe("Medium");
    expect(result.evidence.some((entry) => /stack trace points to/i.test(entry))).toBe(true);
    expect(result.rootCause).toContain("line");
  });

  it("generates a native Python unittest template", () => {
    const input = { language: "Python" as const, error: "RuntimeError: failed", code: "def calculate(value):\n    return value + 1" };
    const { result, plan } = analyze(input);
    const test = buildTest(input, result, plan);
    expect(test.filename).toMatch(/^test_.*\.py$/);
    expect(test.framework).toContain("unittest");
    expect(test.code).toContain("import unittest");
    expect(test.filename).toBe("test_calculate.py");
    expect(test.code).toContain("from solution import calculate");
    expect(test.code).not.toContain("vitest");
    expect(parseGeneratedTest(test).ok).toBe(true);
  });

  it("generates a native JUnit template", () => {
    const input = { language: "Java" as const, error: "IllegalStateException: failed", code: "class Example { void run() {} }" };
    const { result, plan } = analyze(input);
    const test = buildTest(input, result, plan);
    expect(test.filename).toBe("YourClassTest.java");
    expect(test.framework).toContain("JUnit");
    expect(test.code).toContain("org.junit.jupiter.api.Test");
    expect(test.code).not.toContain("vitest");
    expect(parseGeneratedTest(test).ok).toBe(true);
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

// ===========================================================================
// Python analyzer tests (≥3 required)
// ===========================================================================

describe("python: IndexError — empty list access", () => {
  const input = {
    language: "Python" as const,
    error: "IndexError: list index out of range",
    stackTrace: `Traceback (most recent call last):
  File "app.py", line 3, in get_first
    return items[0]
IndexError: list index out of range`,
    code: `def get_first(items):
    return items[0]`,
  };
  const { result } = analyze(input);

  it("recognises IndexError pattern", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem).toMatch(/index|out of range/i);
    expect(result.evidence.some((e) => /IndexError|index/i.test(e))).toBe(true);
  });

  it("reports High confidence when code line found", () => {
    expect(result.confidence).toBe("High");
  });

  it("suggests a bounds check", () => {
    expect(result.suggestedFix.toLowerCase()).toMatch(/len|bounds|index/i);
  });
});

describe("python: KeyError — missing dict key", () => {
  const input = {
    language: "Python" as const,
    error: "KeyError: 'email'",
    stackTrace: `Traceback (most recent call last):
  File "user.py", line 4, in get_email
    return user["email"]
KeyError: 'email'`,
    code: `def get_email(user):
    return user["email"]`,
  };
  const { result } = analyze(input);

  it("identifies the missing key", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem).toMatch(/email|key/i);
    expect(result.rootCause).toMatch(/email/i);
  });

  it("reports High confidence when key access line found", () => {
    expect(result.confidence).toBe("High");
  });

  it("suggests .get() as the fix", () => {
    expect(result.suggestedFix).toContain(".get(");
  });
});

describe("python: ZeroDivisionError", () => {
  const input = {
    language: "Python" as const,
    error: "ZeroDivisionError: division by zero",
    stackTrace: `Traceback (most recent call last):
  File "math.py", line 2, in divide
    return a / b
ZeroDivisionError: division by zero`,
    code: `def divide(a, b):
    return a / b`,
  };
  const { result } = analyze(input);

  it("identifies division by zero", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem.toLowerCase()).toMatch(/zero|division/i);
  });

  it("reports High confidence when division line found", () => {
    expect(result.confidence).toBe("High");
  });

  it("suggests a guard for zero divisor", () => {
    expect(result.suggestedFix.toLowerCase()).toMatch(/!=\s*0|guard|divisor/i);
  });
});

describe("python: TypeError", () => {
  const { result } = analyze({
    language: "Python",
    error: "TypeError: unsupported operand type(s) for +: 'int' and 'str'",
    code: "def add_values(left, right):\n    return left + right",
  });

  it("identifies the incompatible operand types with high confidence", () => {
    expect(result.confidence).toBe("High");
    expect(result.rootCause).toMatch(/int.*str|str.*int/);
    expect(result.evidence.some((entry) => /left \+ right/.test(entry))).toBe(true);
  });
});

describe("python: NameError", () => {
  const { result } = analyze({
    language: "Python",
    error: "NameError: name 'missing_value' is not defined",
    code: "print(missing_value)",
  });

  it("identifies the unresolved name", () => {
    expect(result.confidence).toBe("High");
    expect(result.problem).toContain("missing_value");
  });
});

describe("python: AttributeError", () => {
  const { result } = analyze({
    language: "Python",
    error: "AttributeError: 'NoneType' object has no attribute 'name'",
    code: "def get_name(user):\n    return user.name",
  });

  it("identifies the None attribute access", () => {
    expect(result.confidence).toBe("High");
    expect(result.rootCause).toMatch(/None.*name/);
  });
});

describe("python: ValueError", () => {
  const { result } = analyze({
    language: "Python",
    error: "ValueError: invalid literal for int() with base 10: 'abc'",
    code: "def parse_count(value):\n    return int(value)",
  });

  it("identifies the invalid integer string", () => {
    expect(result.confidence).toBe("High");
    expect(result.problem).toContain("abc");
    expect(result.suggestedFix).toMatch(/validate|try/i);
  });
});

describe("python: wrong arithmetic operator from expected and actual results", () => {
  const input = {
    language: "Python" as const,
    error: "AssertionError: incorrect total",
    code: "def calculate_total(price, quantity):\n    return price + quantity\n\ntotal = calculate_total(10, 3)\nprint(total)",
    expectedResult: "30",
    actualResult: "13",
  };
  const { result, plan } = analyze(input);
  const test = buildTest(input, result, plan);

  it("identifies addition instead of multiplication and safely fixes it", () => {
    expect(result.confidence).toBe("High");
    expect(result.rootCause).toMatch(/addition.*multiplication/i);
    expect(result.fixedCode).toContain("price * quantity");
    expect(plan.kind).toBe("logic-error");
  });

  it("generates a runnable-shaped unittest assertion with inferred arguments", () => {
    expect(test.filename).toBe("test_calculate_total.py");
    expect(test.code).toContain("self.assertEqual(calculate_total(10, 3), 30)");
    expect(test.code).not.toContain("vitest");
  });
});

it("does not guess a specific Python operator without visible call arguments", () => {
  const { result } = analyze({
    language: "Python",
    error: "AssertionError: incorrect total",
    code: "def calculate_total(price, quantity):\n    return price + quantity",
    expectedResult: "30",
    actualResult: "13",
  });

  expect(result.confidence).toBe("Medium");
  expect(result.fixedCode).toBeUndefined();
  expect(result.rootCause).not.toMatch(/multiplication/i);
});

// ===========================================================================
// Java analyzer tests (≥3 required)
// ===========================================================================

describe("java: NullPointerException — Java 14+ message", () => {
  const input = {
    language: "Java" as const,
    error: `Exception in thread "main" java.lang.NullPointerException: Cannot invoke "String.length()" because "str" is null
\tat com.example.StringUtils.process(StringUtils.java:8)`,
    code: `public class StringUtils {
    public int process(String str) {
        return str.length();
    }
}`,
  };
  const { result } = analyze(input);

  it("identifies the NPE with Java 14+ message", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem).toMatch(/null|NullPointer/i);
    expect(result.evidence.some((e) => /str.*null|null.*str/i.test(e))).toBe(true);
  });

  it("reports High confidence when code line found", () => {
    expect(result.confidence).toBe("High");
  });

  it("suggests a null check", () => {
    expect(result.suggestedFix.toLowerCase()).toMatch(/null|Optional|requireNonNull/i);
  });
});

describe("java: NumberFormatException — bad string", () => {
  const input = {
    language: "Java" as const,
    error: `java.lang.NumberFormatException: For input string: "abc"
\tat java.base/java.lang.NumberFormatException.forInputString(NumberFormatException.java:67)
\tat com.example.Parser.parse(Parser.java:5)`,
    code: `public class Parser {
    public int parse(String s) {
        return Integer.parseInt(s);
    }
}`,
  };
  const { result } = analyze(input);

  it("identifies the bad input string", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem).toMatch(/abc|number|parse/i);
    expect(result.evidence.some((e) => /abc|NumberFormatException/i.test(e))).toBe(true);
  });

  it("reports High confidence", () => {
    expect(result.confidence).toBe("High");
  });

  it("suggests try/catch around parseInt", () => {
    expect(result.suggestedFix).toMatch(/try|catch|NumberFormatException/i);
  });
});

describe("java: ArrayIndexOutOfBoundsException", () => {
  const input = {
    language: "Java" as const,
    error: `java.lang.ArrayIndexOutOfBoundsException: Index 5 out of bounds for length 3
\tat com.example.App.getItem(App.java:4)`,
    code: `public class App {
    public int getItem(int[] arr, int index) {
        return arr[index];
    }
}`,
  };
  const { result } = analyze(input);

  it("identifies the bad array index", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem).toMatch(/index|out of bounds/i);
    expect(result.evidence.some((e) => /5|bounds|ArrayIndex/i.test(e))).toBe(true);
  });

  it("reports High confidence when code line found", () => {
    expect(result.confidence).toBe("High");
  });

  it("suggests a bounds check", () => {
    expect(result.suggestedFix.toLowerCase()).toMatch(/length|bounds|check/i);
  });
});

describe("java: ArithmeticException", () => {
  const { result } = analyze({
    language: "Java",
    error: "java.lang.ArithmeticException: / by zero",
    code: "class Divider {\n    int divide(int numerator, int denominator) {\n        return numerator / denominator;\n    }\n}",
  });

  it("identifies integer division by zero", () => {
    expect(result.confidence).toBe("High");
    expect(result.problem).toMatch(/division.*zero/i);
    expect(result.suggestedFix).toMatch(/divisor|!= 0/);
  });
});

describe("java: ClassCastException", () => {
  const { result } = analyze({
    language: "Java",
    error: "java.lang.ClassCastException: class java.lang.Integer cannot be cast to class java.lang.String",
    code: "class Converter {\n    String convert(Object value) {\n        return (String) value;\n    }\n}",
  });

  it("identifies the incompatible runtime types", () => {
    expect(result.confidence).toBe("High");
    expect(result.problem).toMatch(/Integer.*String/);
    expect(result.suggestedFix).toContain("instanceof");
  });
});

describe("java: IllegalArgumentException", () => {
  const { result } = analyze({
    language: "Java",
    error: "java.lang.IllegalArgumentException: bound must be positive",
    code: "class Randomizer {\n    int choose(int bound) {\n        if (bound <= 0) throw new IllegalArgumentException(\"bound must be positive\");\n        return bound;\n    }\n}",
  });

  it("points to the rejected argument and its precondition", () => {
    expect(result.confidence).toBe("High");
    expect(result.problem).toMatch(/bound must be positive/i);
    expect(result.rootCause).toMatch(/precondition/i);
  });
});

describe("java: wrong arithmetic operator from expected and actual results", () => {
  const input = {
    language: "Java" as const,
    error: "AssertionError: incorrect total",
    code: "class Totals {\n    public static int calculateTotal(int price, int quantity) {\n        return price + quantity;\n    }\n    public static void main(String[] args) {\n        int total = calculateTotal(10, 3);\n        System.out.println(total);\n    }\n}",
    expectedResult: "30",
    actualResult: "13",
  };
  const { result, plan } = analyze(input);
  const test = buildTest(input, result, plan);

  it("identifies addition instead of multiplication and safely fixes it", () => {
    expect(result.confidence).toBe("High");
    expect(result.rootCause).toMatch(/addition.*multiplication/i);
    expect(result.fixedCode).toContain("price * quantity");
    expect(plan.kind).toBe("logic-error");
  });

  it("generates a local JUnit assertion with inferred arguments", () => {
    expect(test.filename).toBe("YourClassTest.java");
    expect(test.code).toContain("assertEquals(30, subject.calculateTotal(10, 3))");
    expect(test.code).not.toContain("vitest");
  });
});

it("does not guess a specific Java operator without visible call arguments", () => {
  const { result } = analyze({
    language: "Java",
    error: "AssertionError: incorrect total",
    code: "class Totals {\n    int calculateTotal(int price, int quantity) {\n        return price + quantity;\n    }\n}",
    expectedResult: "30",
    actualResult: "13",
  });

  expect(result.confidence).toBe("Medium");
  expect(result.fixedCode).toBeUndefined();
  expect(result.rootCause).not.toMatch(/multiplication/i);
});

// ===========================================================================
// Additional JS/TS tests (≥3 required)
// ===========================================================================

describe("js: import/module error via ReferenceError — missing import", () => {
  const input = {
    language: "TypeScript" as const,
    error: "ReferenceError: axios is not defined",
    code: `async function fetchData(url: string) {
  const response = await axios.get(url);
  return response.data;
}`,
  };
  const { result } = analyze(input);

  it("identifies axios as undefined", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem).toContain("axios");
  });

  it("reports High confidence — no declaration found", () => {
    expect(result.confidence).toBe("High");
  });

  it("suggests importing or declaring the variable", () => {
    expect(result.suggestedFix.toLowerCase()).toMatch(/import|declare|install/i);
  });
});

describe("js: TypeScript generic TypeError — fallback with stack-trace line", () => {
  const input = {
    language: "TypeScript" as const,
    error: "TypeError: Cannot set properties of undefined (setting 'value')",
    stackTrace: "    at updateField (form.ts:3:15)",
    code: `function updateField(form: any) {
  const input = form.fields[0];
  input.value = "hello";
}`,
  };
  const { result } = analyze(input);

  it("produces a valid result for an unmatched TypeError", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it("mentions the stack trace line in the diagnosis", () => {
    // The fallback should quote the line from the stack trace
    expect(
      result.rootCause.toLowerCase().includes("line 3") ||
      result.evidence.some((e) => /line 3|form\.ts/i.test(e))
    ).toBe(true);
  });

  it("does not report Low confidence when stack trace is provided", () => {
    expect(result.confidence).not.toBe("Low");
  });
});

describe("js: environment / config error via ReferenceError — process not defined", () => {
  const input = {
    language: "JavaScript" as const,
    error: "ReferenceError: process is not defined",
    code: `function getApiUrl() {
  return process.env.API_URL;
}`,
  };
  const { result } = analyze(input);

  it("identifies process as undefined", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.problem).toContain("process");
  });

  it("reports High confidence (no import for process)", () => {
    expect(result.confidence).toBe("High");
  });
});

// ===========================================================================
// Verify / test runner tests (≥2 required)
// ===========================================================================

describe("verify: runSync passes on fixed code and fails on original", () => {
  // Simulate what the Verify button does: run the test on original (should fail) and fixed (should pass)
  const originalCode = `function getInitials(fullName) {
  return fullName
    .split(" ")
    .map((part) => part[0].toUpperCase())
    .join("");
}`;
  const fixedCode = `function getInitials(fullName) {
  if (typeof fullName !== "string" || fullName.trim() === "") {
    return "";
  }
  return fullName
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase())
    .join("");
}`;
  const testCode = `describe("getInitials", () => {
  it("returns initials for a normal name", () => {
    expect(getInitials("Meera Nair")).toBe("MN");
  });
  it("does not throw for an empty string", () => {
    expect(() => getInitials("")).not.toThrow();
    expect(getInitials("")).toBe("");
  });
});`;

  it("original code fails the test (reproduces the bug)", () => {
    const report = runSync(originalCode, testCode);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.results.some((r) => !r.passed)).toBe(true);
    }
  });

  it("fixed code passes all tests (fix is verified)", () => {
    const report = runSync(fixedCode, testCode);
    expect(report.ok).toBe(true);
    if (report.ok) {
      const failed = report.results.filter((r) => !r.passed);
      expect(failed).toEqual([]);
    }
  });
});

describe("verify: runSync isolates errors and shows useful failure output", () => {
  it("reports a meaningful error message when test code throws", () => {
    const code = `function add(a, b) { return a + b; }`;
    const test = `describe("add", () => {
  it("throws intentionally", () => {
    expect(add(1, 2)).toBe(99); // wrong expected value
  });
});`;
    const report = runSync(code, test);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.results[0].passed).toBe(false);
      expect(report.results[0].message).toMatch(/Expected|Received|99/i);
    }
  });

  it("reports parse errors without crashing the runner", () => {
    const report = runSync("function broken() {{{ syntax error", "describe('x', () => {});");
    expect(report.ok).toBe(false);
    if (!report.ok) {
      expect(typeof report.error).toBe("string");
      expect(report.error.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// Harness matcher tests — Fix 1: new matchers + sentinel trap
// ===========================================================================

describe("harness: new matchers work correctly", () => {
  it("toContain passes when array includes the value", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect([1,2,3]).toContain(2); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(true);
  });

  it("toContain fails when array does not include the value", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect([1,2,3]).toContain(9); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(false);
  });

  it("toContain works on strings", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect('hello world').toContain('world'); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(true);
  });

  it("toBeGreaterThan passes when actual > expected", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect(5).toBeGreaterThan(3); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(true);
  });

  it("toBeGreaterThan fails when actual <= expected", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect(3).toBeGreaterThan(5); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(false);
  });

  it("toBeGreaterThanOrEqual passes when actual === expected", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect(3).toBeGreaterThanOrEqual(3); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(true);
  });

  it("toBeLessThan passes when actual < expected", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect(2).toBeLessThan(5); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(true);
  });

  it("toBeLessThanOrEqual passes when actual === expected", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect(4).toBeLessThanOrEqual(4); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(true);
  });

  it("toBeInstanceOf passes for matching constructor", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect(new Error('e')).toBeInstanceOf(Error); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(true);
  });

  it("toBeInstanceOf fails for non-matching constructor", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect('hello').toBeInstanceOf(Error); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(false);
  });

  it("toHaveLength passes for array with correct length", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect([1,2,3]).toHaveLength(3); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(true);
  });

  it("toHaveLength fails for array with wrong length", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect([1,2]).toHaveLength(5); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(false);
  });

  it("toHaveLength works on strings", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect('abc').toHaveLength(3); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(true);
  });

  it("toMatch passes when string matches regex", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect('hello').toMatch(/ell/); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(true);
  });

  it("toMatch fails when string does not match regex", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect('hello').toMatch(/xyz/); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(false);
  });

  it(".not.toContain passes when array does not include the value", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect([1,2,3]).not.toContain(9); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(true);
  });

  it(".not.toBeGreaterThan passes when actual is not greater", () => {
    const r = runSync("", "describe('x', () => { it('t', () => { expect(2).not.toBeGreaterThan(5); }); });");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0].passed).toBe(true);
  });
});

describe("harness: sentinel trap for unsupported matchers", () => {
  it("accessing an unknown matcher fails the test case instead of silently passing", () => {
    // If the sentinel were absent, 'expect(x).toFakeNonExistentMatcher()' would return
    // undefined (falsy? no — the call to undefined() would throw TypeError, but accessing
    // the property itself returns undefined, which IS a truthy call target in some engines).
    // With the Proxy sentinel it throws immediately with a clear error message.
    const r = runSync(
      "function f() { return 1; }",
      "describe('x', () => { it('t', () => { expect(f()).toNonExistentMatcher(); }); });"
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.results[0].passed).toBe(false);
      expect(r.results[0].message).toMatch(/Unsupported matcher|toNonExistentMatcher/i);
    }
  });

  it("accessing an unknown .not matcher also fails with a clear message", () => {
    const r = runSync(
      "function f() { return 1; }",
      "describe('x', () => { it('t', () => { expect(f()).not.toNonExistentMatcher(); }); });"
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.results[0].passed).toBe(false);
      expect(r.results[0].message).toMatch(/Unsupported matcher|toNonExistentMatcher/i);
    }
  });
});

// ===========================================================================
// Python/Java fallback message tests — Fix 2
// ===========================================================================

describe("python fallback: unrecognised Python error uses partial-support message", () => {
  const { result } = analyze({
    language: "Python",
    error: "RecursionError: maximum recursion depth exceeded",
    code: "def f(n):\n    return f(n - 1)",
  });

  it("produces a valid result", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
  });

  it("does NOT say 'only understands JavaScript and TypeScript'", () => {
    const allText = [result.rootCause, ...result.evidence].join(" ");
    expect(allText).not.toMatch(/only understands JavaScript and TypeScript/i);
  });

  it("mentions partial Python support and that this error is not recognised", () => {
    const allText = [result.rootCause, ...result.evidence].join(" ");
    expect(allText).toMatch(/partial.*Python|Python.*partial/i);
  });
});

describe("java fallback: unrecognised Java error uses partial-support message", () => {
  const { result } = analyze({
    language: "Java",
    error: "java.lang.StackOverflowError",
    code: "public void recurse() { recurse(); }",
  });

  it("produces a valid result", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
  });

  it("does NOT say 'only understands JavaScript and TypeScript'", () => {
    const allText = [result.rootCause, ...result.evidence].join(" ");
    expect(allText).not.toMatch(/only understands JavaScript and TypeScript/i);
  });

  it("mentions partial Java support and that this error is not recognised", () => {
    const allText = [result.rootCause, ...result.evidence].join(" ");
    expect(allText).toMatch(/partial.*Java|Java.*partial/i);
  });
});

describe("other language fallback: still says 'only understands JavaScript and TypeScript'", () => {
  const { result } = analyze({
    language: "Other",
    error: "Some error in Ruby",
    code: "x = 1",
  });

  it("produces a valid result with Low confidence", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
    expect(result.confidence).toBe("Low");
  });

  it("says the analyzer only understands JS and TS for Other languages", () => {
    const allText = [result.rootCause, ...result.evidence].join(" ");
    expect(allText).toMatch(/only understands JavaScript and TypeScript/i);
  });
});

// ===========================================================================
// not-a-function test generator — Fix 3: no TODO in generated test
// ===========================================================================

describe("test generator: not-a-function case produces a runnable test (no TODO)", () => {
  const input = {
    language: "JavaScript" as const,
    error: "TypeError: users.filter is not a function",
    code: `function getActiveUsers(users) {
  return users.filter(u => u.active);
}`,
  };
  const { result, plan } = analyze(input);

  it("analyzer identifies the not-a-function pattern", () => {
    expect(plan.kind).toBe("not-a-function");
  });

  it("generated test does not contain // TODO", () => {
    const test = buildTest(input, result, plan);
    expect(test.code).not.toContain("// TODO");
  });

  it("generated test is valid and contains a describe block", () => {
    const test = buildTest(input, result, plan);
    expect(parseGeneratedTest(test).ok).toBe(true);
    expect(test.code).toContain("describe(");
  });
});

// ===========================================================================
// Logic bug with expected/actual — the core scenario from the issue
// ===========================================================================

describe("logic bug: wrong operator detected from expected/actual (price + quantity → *)", () => {
  const input = {
    language: "JavaScript" as const,
    error: "No error message. The function returns the wrong result.",
    code: `function calculateTotal(price, quantity) {
  return price + quantity;
}

const total = calculateTotal(10, 3);
console.log(total);`,
    expectedResult: "30",
    actualResult: "13",
  };
  const { result } = analyze(input);

  it("produces a valid investigation result", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
  });

  it("reports High confidence when operator can be verified", () => {
    expect(result.confidence).toBe("High");
  });

  it("identifies the wrong operator in the problem statement", () => {
    expect(result.problem).toMatch(/\+|\*/);
  });

  it("mentions expected result 30 and actual result 13 in evidence", () => {
    const text = result.evidence.join(" ");
    expect(text).toMatch(/30/);
    expect(text).toMatch(/13/);
  });

  it("quotes the return expression in evidence", () => {
    const text = result.evidence.join(" ");
    expect(text).toMatch(/price.*quantity|price \+ quantity/i);
  });

  it("explains the operator replacement in the suggested fix", () => {
    expect(result.suggestedFix).toMatch(/\*/);
    expect(result.suggestedFix).toMatch(/\+/);
  });

  it("produces a fixedCode with * instead of +", () => {
    expect(result.fixedCode).toBeTruthy();
    expect(result.fixedCode).toContain("price * quantity");
    expect(result.fixedCode).not.toContain("price + quantity");
  });

  it("fixed code actually produces 30 when run", () => {
    const test = `describe("calculateTotal", () => {
  it("returns price * quantity", () => {
    expect(calculateTotal(10, 3)).toBe(30);
  });
});`;
    if (result.fixedCode) {
      const report = runSync(result.fixedCode, test);
      expect(report.ok).toBe(true);
      if (report.ok) {
        expect(report.results[0].passed).toBe(true);
      }
    }
  });

  it("original code fails the corrected test", () => {
    const test = `describe("calculateTotal", () => {
  it("returns price * quantity", () => {
    expect(calculateTotal(10, 3)).toBe(30);
  });
});`;
    const report = runSync(input.code, test);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.results[0].passed).toBe(false);
    }
  });
});

describe("logic bug: only expected provided — no fabrication, Medium confidence", () => {
  const { result } = analyze({
    language: "JavaScript" as const,
    error: "No error message. The function returns the wrong result.",
    code: `function double(n) {
  return n + n;
}`,
    expectedResult: "some-string-result",
    // no actualResult
  });

  it("produces a valid result", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
  });

  it("does not claim High confidence without both numeric values", () => {
    // 'some-string-result' is not a number so operator inference cannot fire
    expect(result.confidence).not.toBe("High");
  });

  it("mentions the expected result in evidence", () => {
    expect(result.evidence.join(" ")).toContain("some-string-result");
  });

  it("does not fabricate an actualResult that was not given", () => {
    // The evidence should NOT invent an actual number
    expect(result.evidence.join(" ")).not.toMatch(/actual result.*\d+/i);
  });
});

describe("logic bug: expected/actual provided but no arithmetic return — still useful", () => {
  const { result } = analyze({
    language: "JavaScript" as const,
    error: "No error. Wrong output.",
    code: `function greet(name) {
  return "Hello " + name;
}`,
    expectedResult: "Hi Alice",
    actualResult: "Hello Alice",
  });

  it("produces a valid result", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
  });

  it("mentions both the expected and actual in evidence or suggested fix", () => {
    const text = [result.rootCause, result.suggestedFix, ...result.evidence].join(" ");
    expect(text).toMatch(/Hi Alice|Hello Alice/);
  });
});

describe("logic bug: no expected/actual and generic error — existing behaviour preserved", () => {
  const { result } = analyze({
    language: "JavaScript" as const,
    error: "Error: assertion failed",
    code: `function checkAge(age) {
  if (age = 18) return true;
  return false;
}`,
  });

  it("produces a valid result", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
  });

  it("still detects assignment-in-condition", () => {
    expect(result.evidence.join(" ")).toMatch(/assignment|=.*if|single.*=/i);
  });
});

describe("logic bug: no expected/actual and no generic error — Low confidence fallback", () => {
  const { result } = analyze({
    language: "JavaScript" as const,
    error: "No error message. The function returns the wrong result.",
    code: `function calculateTotal(price, quantity) {
  return price + quantity;
}`,
    // no expectedResult, no actualResult
  });

  it("produces a valid result", () => {
    expect(parseInvestigationResult(result).ok).toBe(true);
  });

  it("reports Low confidence (cannot identify any logic bug without more info)", () => {
    // Without expected/actual and without a generic error signal,
    // the logic analyzer does not fire, so we get the generic fallback.
    expect(result.confidence).toBe("Low");
  });
});

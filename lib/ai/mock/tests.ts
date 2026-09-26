import type { GeneratedTest, InvestigationInput, InvestigationResult } from "@/lib/types";
import type { TestPlan } from "./analyzer";
import { jsLiteral } from "./text";

const sample = (prop: string) => (/name/i.test(prop) ? "Meera" : /email/i.test(prop) ? "meera@example.com" : "sample");

/** Nested object such as { user: { name: "Meera" } } for path ["user"] and prop "name". */
function nested(path: string[], prop: string, leaf: unknown): unknown {
  return path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), { [prop]: leaf });
}

type Case = { title: string; body: string[] };

function header(fnName: string, problem: string, ext: string): string {
  return [
    `import { describe, it, expect } from "vitest";`,
    `import { ${fnName} } from "./${fnName}"; // export ${fnName} from your file if it is not exported yet`,
    ``,
    `// Regression test: ${problem.replace(/`/g, "").replace(/\n/g, " ")}`,
    `// Fails on the original code, passes on the fix (${ext}).`,
  ].join("\n");
}

function render(fnName: string, problem: string, ext: string, cases: Case[]): string {
  const blocks = cases.map((c) => [`  it(${JSON.stringify(c.title)}, () => {`, ...c.body.map((l) => `    ${l}`), `  });`].join("\n"));
  return `${header(fnName, problem, ext)}\n\ndescribe(${JSON.stringify(fnName)}, () => {\n${blocks.join("\n\n")}\n});\n`;
}

export function buildTest(input: InvestigationInput, result: InvestigationResult, plan: TestPlan): GeneratedTest {
  const ext = input.language === "TypeScript" ? "ts" : "js";
  const framework = "Vitest (also works with Jest)";

  switch (plan.kind) {
    case "null-guard": {
      const { fnName, path, prop, returnsProp } = plan;
      const missing = path.length ? "{}" : "undefined";
      const cases: Case[] = [
        {
          title: "works when the data is complete (normal case)",
          body: returnsProp
            ? [`expect(${fnName}(${jsLiteral(nested(path, prop, sample(prop)))})).toBe(${JSON.stringify(sample(prop))});`]
            : [`expect(() => ${fnName}(${jsLiteral(nested(path, prop, sample(prop)))})).not.toThrow();`],
        },
        {
          title: path.length ? `does not throw when ${path.join(".")} is missing (the bug)` : "does not throw when the value is missing (the bug)",
          body: returnsProp
            ? [`expect(() => ${fnName}(${missing})).not.toThrow();`, `expect(${fnName}(${missing})).toBeNull();`]
            : [`expect(() => ${fnName}(${missing})).not.toThrow();`],
        },
        {
          title: "does not throw when the input itself is undefined",
          body: [`expect(() => ${fnName}(undefined)).not.toThrow();`],
        },
        {
          title: "does not throw when the input is null",
          body: [`expect(() => ${fnName}(null)).not.toThrow();`],
        },
      ];
      return {
        framework,
        filename: `${fnName}.test.${ext}`,
        code: render(fnName, result.problem, ext, cases),
        covers: ["Normal case with complete data", "Missing value (the original bug)", "Undefined input", "Null input"],
      };
    }

    case "contract-mismatch": {
      const { fnName, actualKey, prop, sampleValue } = plan;
      const cases: Case[] = [
        {
          title: `reads ${prop} from the ${actualKey} object the API returns (normal case)`,
          body: [`expect(${fnName}(${jsLiteral({ [actualKey]: { [prop]: sampleValue } })})).toBe(${jsLiteral(sampleValue)});`],
        },
        {
          title: `does not throw when ${actualKey} is missing (the bug)`,
          body: [`expect(() => ${fnName}({})).not.toThrow();`, `expect(${fnName}({})).toBeNull();`],
        },
        {
          title: "does not throw when the response is undefined",
          body: [`expect(() => ${fnName}(undefined)).not.toThrow();`],
        },
        {
          title: "does not throw when the response is null",
          body: [`expect(() => ${fnName}(null)).not.toThrow();`],
        },
      ];
      return {
        framework,
        filename: `${fnName}.test.${ext}`,
        code: render(fnName, result.problem, ext, cases),
        covers: [`Response shaped like the real API (${actualKey}.${prop})`, `Response without ${actualKey} (the original bug)`, "Undefined response", "Null response"],
      };
    }

    case "empty-input": {
      const { fnName, fallback, template } = plan;
      const cases: Case[] =
        template === "initials"
          ? [
              { title: "returns the initials for a normal name", body: [`expect(${fnName}("Meera Nair")).toBe("MN");`] },
              { title: "returns an empty result for an empty string (the bug)", body: [`expect(() => ${fnName}("")).not.toThrow();`, `expect(${fnName}("")).toBe(${fallback});`] },
              { title: "returns an empty result for whitespace only", body: [`expect(${fnName}("   ")).toBe(${fallback});`] },
              { title: "returns an empty result when the input is undefined", body: [`expect(${fnName}(undefined)).toBe(${fallback});`] },
              { title: "ignores repeated spaces between words", body: [`expect(${fnName}("Meera  Nair")).toBe("MN");`] },
              { title: "works with a single word in lowercase", body: [`expect(${fnName}("meera")).toBe("M");`] },
            ]
          : [
              { title: "does not throw for a normal value", body: [`expect(() => ${fnName}("Meera Nair")).not.toThrow();`] },
              { title: "does not throw for an empty string (the bug)", body: [`expect(() => ${fnName}("")).not.toThrow();`] },
              { title: "does not throw for whitespace only", body: [`expect(() => ${fnName}("   ")).not.toThrow();`] },
              { title: "does not throw when the input is undefined", body: [`expect(() => ${fnName}(undefined)).not.toThrow();`] },
              { title: "does not throw with repeated spaces", body: [`expect(() => ${fnName}("Meera  Nair")).not.toThrow();`] },
            ];
      return {
        framework,
        filename: `${fnName}.test.${ext}`,
        code: render(fnName, result.problem, ext, cases),
        covers: ["Normal input", "Empty string (the original bug)", "Whitespace only", "Undefined input", "Repeated separators"],
      };
    }

    case "empty-collection": {
      const { fnName, prop, returnsProp } = plan;
      const cases: Case[] = [
        {
          title: "works with one item (normal case)",
          body: returnsProp
            ? [`expect(${fnName}([{ ${prop}: ${JSON.stringify(sample(prop))} }])).toBe(${JSON.stringify(sample(prop))});`]
            : [`expect(() => ${fnName}([{ ${prop}: ${JSON.stringify(sample(prop))} }])).not.toThrow();`],
        },
        {
          title: "does not throw for an empty list (the bug)",
          body: returnsProp ? [`expect(() => ${fnName}([])).not.toThrow();`, `expect(${fnName}([])).toBeNull();`] : [`expect(() => ${fnName}([])).not.toThrow();`],
        },
        { title: "does not throw when the list is undefined", body: [`expect(() => ${fnName}(undefined)).not.toThrow();`] },
      ];
      return {
        framework,
        filename: `${fnName}.test.${ext}`,
        code: render(fnName, result.problem, ext, cases),
        covers: ["One item (normal case)", "Empty list (the original bug)", "Undefined list"],
      };
    }

    case "not-a-function": {
      const fnName = plan.fnName ?? "yourFunction";
      const { callee } = plan;
      // For "not-a-function" we always have enough information to write a runnable test:
      // the callee name is known, and the fix is to guard against non-function values.
      // No TODO placeholders are needed here.
      const cases: Case[] = [
        {
          title: `does not throw when ${callee} is a valid function (normal case)`,
          body: [
            `const validFn = () => "ok";`,
            `expect(() => ${fnName}(validFn)).not.toThrow();`,
          ],
        },
        {
          title: `does not throw when ${callee} is undefined (after the fix)`,
          body: [`expect(() => ${fnName}(undefined)).not.toThrow();`],
        },
        {
          title: `does not throw when ${callee} is null (after the fix)`,
          body: [`expect(() => ${fnName}(null)).not.toThrow();`],
        },
        {
          title: `does not throw when ${callee} is a plain object instead of a function`,
          body: [`expect(() => ${fnName}({})).not.toThrow();`],
        },
      ];
      return {
        framework,
        filename: `${fnName}.test.${ext}`,
        code: render(fnName, result.problem, ext, cases),
        covers: ["Valid function value (normal case)", "undefined value", "null value", "Non-function value (the bug)"],
      };
    }

    case "stack-overflow": {
      const { fnName } = plan;
      // Stack overflow tests always need the developer to fill in input values — the analyzer
      // cannot know the domain values that trigger or avoid recursion from the snippet alone.
      // The placeholders below are clearly labelled; the test is NOT runnable as-is.
      const cases: Case[] = [
        {
          title: "does not throw for the base case (fill in the smallest non-recursive input)",
          body: [
            `// Fill in: the smallest input that should return directly without recursing.`,
            `// Examples: 0 for a factorial, "" for a string processor, [] for a list function.`,
            `const baseCase = undefined; // TODO: replace with your base-case input`,
            `expect(() => ${fnName}(baseCase)).not.toThrow();`,
          ],
        },
        {
          title: "returns the expected value for a small input (fill in input and result)",
          body: [
            `// Fill in: a small valid input and the exact result you expect back.`,
            `const smallInput = undefined; // TODO: e.g. 1, "a", [1]`,
            `const expected = undefined;   // TODO: the value ${fnName}(smallInput) should return`,
            `expect(${fnName}(smallInput)).toEqual(expected);`,
          ],
        },
        {
          title: "does not throw for the input that originally caused the crash (after the fix)",
          body: [
            `// Fill in: paste the exact input that triggered the stack overflow.`,
            `const crashInput = undefined; // TODO: the input that caused Maximum call stack exceeded`,
            `expect(() => ${fnName}(crashInput)).not.toThrow();`,
          ],
        },
      ];
      return {
        framework,
        filename: `${fnName}.test.${ext}`,
        code: render(fnName, result.problem, ext, cases),
        covers: ["Base case (must not recurse)", "Small valid input", "Input that triggered the crash"],
      };
    }

    case "logic-error": {
  const fnName = plan.fnName;
  const args = plan.args.map((value) => JSON.stringify(value)).join(", ");

  const code = [
    `import { describe, it, expect } from "vitest";`,
    `import { ${fnName} } from "./${fnName}";`,
    ``,
    `describe(${JSON.stringify(fnName)}, () => {`,
    `  it("returns the expected result for the failing input", () => {`,
    `    expect(${fnName}(${args})).toBe(${JSON.stringify(plan.expected)});`,
    `  });`,
    ``,
    `  it("handles zero input", () => {`,
    `    expect(${fnName}(${plan.args.map((value, index) => index === plan.args.length - 1 ? "0" : JSON.stringify(value)).join(", ")})).toBe(0);`,
    `  });`,
    ``,
    `  it("handles a negative input", () => {`,
    `    expect(${fnName}(${plan.args.map((value, index) => index === plan.args.length - 1 ? "-1" : JSON.stringify(value)).join(", ")})).toBeLessThan(0);`,
    `  });`,
    `});`,
    ``,
  ].join("\n");

  return {
    framework,
    filename: `${fnName}.test.${ext}`,
    code,
    covers: [
      "The original failing input",
      "Zero input",
      "Negative input",
    ],
  };
}
    case "generic": {
      const fnName = plan.fnName ?? "yourFunction";
      // The generic plan does not have enough information to produce concrete test values.
      // The test is a template — the developer must fill in the TODO values before running it.
      const code = [
        `import { describe, it, expect } from "vitest";`,
        `import { ${fnName} } from "./${fnName}";`,
        ``,
        `// Template: the built-in analyzer identified the problem but cannot determine`,
        `// the exact input values from the pasted code alone.`,
        `// Fill in the TODO values with the real inputs, then run the test.`,
        `describe(${JSON.stringify(fnName)}, () => {`,
        `  it("does not throw for the input that caused the error", () => {`,
        `    const failingInput = undefined; // TODO: paste the exact input that reproduced the error`,
        `    expect(() => ${fnName}(failingInput)).not.toThrow();`,
        `  });`,
        ``,
        `  it("still works for a normal input", () => {`,
        `    const normalInput = undefined; // TODO: a valid input that should succeed`,
        `    const expected = undefined;    // TODO: the value ${fnName}(normalInput) should return`,
        `    expect(${fnName}(normalInput)).toEqual(expected);`,
        `  });`,
        `});`,
        ``,
      ].join("\n");
      return {
        framework,
        filename: `${fnName}.test.${ext}`,
        code,
        covers: ["Template for the failing input", "Template for a normal input"],
      };
    }
  }
}

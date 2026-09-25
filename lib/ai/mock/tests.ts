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

    case "generic": {
      const fnName = plan.fnName ?? "yourFunction";
      const code = [
        `import { describe, it, expect } from "vitest";`,
        `import { ${fnName} } from "./${fnName}";`,
        ``,
        `// Template only: the built-in analyzer could not work out concrete inputs for this bug.`,
        `// Replace the TODO values with the input that triggered the error, then run the test.`,
        `describe(${JSON.stringify(fnName)}, () => {`,
        `  it("does not throw for the input that caused the error", () => {`,
        `    const failingInput = undefined; // TODO: the exact input that reproduced the error`,
        `    expect(() => ${fnName}(failingInput)).not.toThrow();`,
        `  });`,
        ``,
        `  it("still works for a normal input", () => {`,
        `    const normalInput = undefined; // TODO: a valid input`,
        `    const expected = undefined; // TODO: the expected result`,
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

/**
 * A tiny, dependency-free test harness (describe / it / expect) that runs plain JavaScript.
 *
 * Why it exists: it lets Bug Detective REALLY run the generated test against the original code
 * (should fail) and against the suggested fix (should pass), inside the browser.
 * The source is kept as a string so the same code runs in a Web Worker (browser) and in
 * `new Function` (Node, for our own tests).
 *
 * Supported matchers: toBe, toEqual, toBeNull, toBeUndefined, toBeTruthy, toBeFalsy, toThrow,
 * and `.not` for all of them. JavaScript only (no TypeScript syntax, no imports).
 */
export const HARNESS_SOURCE = [
  "function __runTests(userCode, testCode) {",
  "  var results = [];",
  "  var stack = [];",
  "  function fmt(v) { if (v === undefined) return 'undefined'; try { return JSON.stringify(v); } catch (e) { return String(v); } }",
  "  function describe(name, fn) { stack.push(name); try { fn(); } finally { stack.pop(); } }",
  "  function it(name, fn) {",
  "    var full = stack.concat([name]).join(' > ');",
  "    try { fn(); results.push({ name: full, passed: true }); }",
  "    catch (e) { results.push({ name: full, passed: false, message: String(e && e.message ? e.message : e) }); }",
  "  }",
  "  function same(a, b) { return fmt(a) === fmt(b); }",
  "  function expect(actual) {",
  "    var check = function (negate) {",
  "      function assert(ok, message) { if (negate ? ok : !ok) throw new Error(negate ? 'Expected NOT: ' + message : message); }",
  "      return {",
  "        toBe: function (e) { assert(Object.is(actual, e), 'Expected ' + fmt(e) + ' but received ' + fmt(actual)); },",
  "        toEqual: function (e) { assert(same(actual, e), 'Expected ' + fmt(e) + ' but received ' + fmt(actual)); },",
  "        toBeNull: function () { assert(actual === null, 'Expected null but received ' + fmt(actual)); },",
  "        toBeUndefined: function () { assert(actual === undefined, 'Expected undefined but received ' + fmt(actual)); },",
  "        toBeTruthy: function () { assert(!!actual, 'Expected a truthy value but received ' + fmt(actual)); },",
  "        toBeFalsy: function () { assert(!actual, 'Expected a falsy value but received ' + fmt(actual)); },",
  "        toThrow: function () {",
  "          var threw = false, err = null;",
  "          try { actual(); } catch (e) { threw = true; err = e; }",
  "          if (negate && threw) throw new Error('Expected function not to throw, but it threw: ' + (err && err.message ? err.message : String(err)));",
  "          if (!negate && !threw) throw new Error('Expected function to throw, but it did not');",
  "        }",
  "      };",
  "    };",
  "    var api = check(false);",
  "    api.not = check(true);",
  "    return api;",
  "  }",
  "  var cleanCode = userCode.replace(/^\\s*export\\s+default\\s+/gm, '').replace(/^\\s*export\\s+/gm, '');",
  "  var cleanTest = testCode.replace(/^\\s*import\\s[^;\\n]*;?[ \\t]*(\\/\\/.*)?$/gm, '');",
  "  var run = new Function('describe', 'it', 'test', 'expect', cleanCode + '\\n;\\n' + cleanTest);",
  "  run(describe, it, it, expect);",
  "  return results;",
  "}",
].join("\n");

export type TestCaseResult = { name: string; passed: boolean; message?: string };

export type RunReport =
  | { ok: true; results: TestCaseResult[] }
  | { ok: false; error: string; timedOut?: boolean };

/** Runs the harness synchronously. Used by our Node tests; the browser uses a Worker (see run-in-worker.ts). */
export function runSync(code: string, test: string): RunReport {
  try {
    const results = new Function(`${HARNESS_SOURCE}\nreturn __runTests(arguments[0], arguments[1]);`)(code, test) as TestCaseResult[];
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

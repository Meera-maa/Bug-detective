/**
 * A tiny, dependency-free test harness (describe / it / expect) that runs plain JavaScript.
 *
 * Why it exists: it lets Bug Detective REALLY run the generated test against the original code
 * (should fail) and against the suggested fix (should pass), inside the browser.
 * The source is kept as a string so the same code runs in a Web Worker (browser) and in
 * `new Function` (Node, for our own tests).
 *
 * Supported matchers: toBe, toEqual, toBeNull, toBeUndefined, toBeTruthy, toBeFalsy, toThrow,
 * toContain, toBeGreaterThan, toBeGreaterThanOrEqual, toBeLessThan, toBeLessThanOrEqual,
 * toBeInstanceOf, toHaveLength, toMatch — and `.not` for all of them.
 *
 * Any unknown property access on the matcher object throws immediately so that unsupported
 * matchers can never silently produce a false PASS.
 *
 * JavaScript only (no TypeScript syntax, no imports).
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
  "      var matchers = {",
  "        toBe: function (e) { assert(Object.is(actual, e), 'Expected ' + fmt(e) + ' but received ' + fmt(actual)); },",
  "        toEqual: function (e) { assert(same(actual, e), 'Expected ' + fmt(e) + ' but received ' + fmt(actual)); },",
  "        toBeNull: function () { assert(actual === null, 'Expected null but received ' + fmt(actual)); },",
  "        toBeUndefined: function () { assert(actual === undefined, 'Expected undefined but received ' + fmt(actual)); },",
  "        toBeTruthy: function () { assert(!!actual, 'Expected a truthy value but received ' + fmt(actual)); },",
  "        toBeFalsy: function () { assert(!actual, 'Expected a falsy value but received ' + fmt(actual)); },",
  "        toContain: function (e) {",
  "          var ok = Array.isArray(actual) ? actual.indexOf(e) !== -1 : typeof actual === 'string' && actual.indexOf(e) !== -1;",
  "          assert(ok, 'Expected ' + fmt(actual) + ' to contain ' + fmt(e));",
  "        },",
  "        toBeGreaterThan: function (e) { assert(actual > e, 'Expected ' + fmt(actual) + ' to be greater than ' + fmt(e)); },",
  "        toBeGreaterThanOrEqual: function (e) { assert(actual >= e, 'Expected ' + fmt(actual) + ' to be >= ' + fmt(e)); },",
  "        toBeLessThan: function (e) { assert(actual < e, 'Expected ' + fmt(actual) + ' to be less than ' + fmt(e)); },",
  "        toBeLessThanOrEqual: function (e) { assert(actual <= e, 'Expected ' + fmt(actual) + ' to be <= ' + fmt(e)); },",
  "        toBeInstanceOf: function (C) { assert(actual instanceof C, 'Expected ' + fmt(actual) + ' to be an instance of ' + (C && C.name ? C.name : String(C))); },",
  "        toHaveLength: function (e) { assert(actual != null && actual.length === e, 'Expected length ' + fmt(e) + ' but received ' + fmt(actual != null ? actual.length : actual)); },",
  "        toMatch: function (pattern) {",
  "          var re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern));",
  "          assert(re.test(String(actual)), 'Expected ' + fmt(actual) + ' to match ' + String(pattern));",
  "        },",
  "        toThrow: function () {",
  "          var threw = false, err = null;",
  "          try { actual(); } catch (e) { threw = true; err = e; }",
  "          if (negate && threw) throw new Error('Expected function not to throw, but it threw: ' + (err && err.message ? err.message : String(err)));",
  "          if (!negate && !threw) throw new Error('Expected function to throw, but it did not');",
  "        }",
  "      };",
  // Sentinel: accessing any unknown property on the matcher throws immediately.
  // This prevents unsupported matchers from silently returning undefined (truthy object)
  // and producing a false PASS.
  "      return new Proxy(matchers, {",
  "        get: function (target, prop) {",
  "          if (prop in target) return target[prop];",
  "          if (prop === 'not' || prop === '__esModule' || typeof prop === 'symbol') return undefined;",
  "          throw new Error('Unsupported matcher: expect(...)' + (negate ? '.not' : '') + '.' + String(prop) + '() — add it to the Bug Detective harness (lib/runner/harness.ts)');",
  "        }",
  "      });",
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

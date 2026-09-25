import { HARNESS_SOURCE, type RunReport, type TestCaseResult } from "./harness";

const WORKER_SOURCE = `
${HARNESS_SOURCE}
self.onmessage = function (event) {
  // No network access from inside the test sandbox.
  try { self.fetch = undefined; self.XMLHttpRequest = undefined; self.WebSocket = undefined; self.importScripts = undefined; } catch (e) {}
  try {
    self.postMessage({ ok: true, results: __runTests(event.data.code, event.data.test) });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message ? err.message : err) });
  }
};
`;

/**
 * Runs code + test in an isolated Web Worker (no DOM, no network, killed after a timeout).
 * Works for JavaScript only.
 */
export function runInWorker(code: string, test: string, timeoutMs = 3000): Promise<RunReport> {
  return new Promise((resolve) => {
    let worker: Worker | null = null;
    let url = "";
    const finish = (report: RunReport) => {
      clearTimeout(timer);
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
      resolve(report);
    };
    const timer = setTimeout(
      () => finish({ ok: false, timedOut: true, error: `The test took longer than ${timeoutMs / 1000}s and was stopped (possible infinite loop).` }),
      timeoutMs,
    );

    try {
      url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
      worker = new Worker(url);
      worker.onmessage = (e: MessageEvent<{ ok: boolean; results?: TestCaseResult[]; error?: string }>) => {
        finish(e.data.ok ? { ok: true, results: e.data.results ?? [] } : { ok: false, error: e.data.error ?? "Unknown error" });
      };
      worker.onerror = (e) => finish({ ok: false, error: e.message || "The test worker crashed." });
      worker.postMessage({ code, test });
    } catch (e) {
      finish({ ok: false, error: e instanceof Error ? e.message : "Could not start the test runner." });
    }
  });
}

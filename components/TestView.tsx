"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { generateTest, UserFacingError } from "@/lib/client/api";
import type { RunReport, TestCaseResult } from "@/lib/runner/harness";
import { runInWorker } from "@/lib/runner/run-in-worker";
import { attachTest, clearInvestigationDraft, removeRecord } from "@/lib/storage";
import type { InvestigationRecord } from "@/lib/types";
import { CodeBlock } from "./CodeBlock";
import { CopyButton } from "./CopyButton";
import { Notice } from "./Notice";
import { RecordGate } from "./RecordGate";
import { Stepper } from "./Stepper";
import { btnPrimary, btnSecondary, card } from "./ui";

type Verification = { before: RunReport; after: RunReport };

function summarize(report: RunReport): { pass: boolean; label: string; detail: string; cases: TestCaseResult[] } {
  if (!report.ok) return { pass: false, label: "ERROR", detail: report.error, cases: [] };
  const failed = report.results.filter((r) => !r.passed).length;
  const total = report.results.length;
  return {
    pass: failed === 0 && total > 0,
    label: failed === 0 && total > 0 ? "PASS ✓" : "FAIL ✕",
    detail: total === 0 ? "No tests ran." : failed === 0 ? `${total} of ${total} tests passed` : `${failed} of ${total} tests failed`,
    cases: report.results,
  };
}

function RunRow({ title, note, report }: { title: string; note: string; report: RunReport }) {
  const s = summarize(report);
  return (
    <div className="rounded-lg border border-line bg-code">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted">{note}</p>
        </div>
        <div className="text-right">
          <p className={`font-mono text-sm font-bold ${s.pass ? "text-ok" : "text-danger"}`}>{s.label}</p>
          <p className="text-xs text-muted">{s.detail}</p>
        </div>
      </div>
      {s.cases.length > 0 && (
        <details className="border-t border-line">
          <summary className="cursor-pointer select-none px-4 py-2 text-xs text-muted hover:text-ink">Show each test</summary>
          <ul className="space-y-1.5 px-4 pb-3 text-[13px]">
            {s.cases.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span className={`font-mono ${c.passed ? "text-ok" : "text-danger"}`} aria-label={c.passed ? "passed" : "failed"}>
                  {c.passed ? "✓" : "✕"}
                </span>
                <span className="min-w-0">
                  <span className="text-ink/90">{c.name}</span>
                  {c.message && <span className="block break-words font-mono text-xs text-muted">{c.message}</span>}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function View({ record }: { record: InvestigationRecord }) {
  const router = useRouter();
  const { input, result, test } = record;
  const [busy, setBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [verification, setVerification] = useState<Verification | null>(null);

  const isTemplate = test ? /(?:\/\/|#) TODO/.test(test.code) : false;
  const localCommand = input.language === "Python"
    ? `pytest ${test?.filename ?? "test_<function>.py"}`
    : input.language === "Java"
      ? "mvn test"
      : `npx vitest run ${test?.filename ?? "<test-file>"}`;
  const localRunLabel = input.language === "Python"
    ? "Run test locally with pytest"
    : input.language === "Java"
      ? "Run test locally with JUnit"
      : "Run test locally with Vitest";
  const runBlocker =
    input.language !== "JavaScript"
      ? `In-browser running supports JavaScript only. Run this ${input.language} test in your local project.`
      : !result.fixedCode
        ? "There is no automatic fix to run the test against."
        : isTemplate
          ? "This test is a template. Fill in the TODO values first, then run it locally."
          : null;

  const before = verification ? summarize(verification.before) : null;
  const after = verification ? summarize(verification.after) : null;
  const beforeFailed = verification?.before.ok === true && !before!.pass;
  const verified = Boolean(verification && beforeFailed && after?.pass);

  function onStartNewInvestigation() {
    removeRecord(record.id);
    clearInvestigationDraft();
    router.replace("/");
  }

  async function onGenerate() {
    setBusy(true);
    setGenError(null);
    try {
      attachTest(record.id, await generateTest(input, result));
    } catch (e) {
      setGenError(e instanceof UserFacingError ? e.message : "The test could not be generated. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onRun() {
    if (!test || !result.fixedCode) return;
    setRunning(true);
    setVerification(null);
    const beforeReport = await runInWorker(input.code, test.code);
    const afterReport = await runInWorker(result.fixedCode, test.code);
    setVerification({ before: beforeReport, after: afterReport });
    setRunning(false);
  }

  return (
    <div className="space-y-6">
      <header className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              <span aria-hidden="true">🧪 </span>Regression Test
            </h1>
            <p className="mt-1 text-sm text-muted">
              {record.title} · generated by {record.provider}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`/investigation/${record.id}`} className={btnSecondary}>
              ← Back to investigation
            </Link>
            <button type="button" onClick={onStartNewInvestigation} className={btnPrimary}>
              Start New Investigation
            </button>
          </div>
        </div>
        <div className={`${card} px-4 py-4 sm:px-6`}>
          <Stepper
            done={verification ? 5 : test ? 4 : 3}
            actions={test ? (
              <>
                <CopyButton text={test.code} label="Copy Test" />
                {input.language === "JavaScript" ? (
                  <button type="button" onClick={onRun} disabled={running || !result.fixedCode} className={btnPrimary} aria-busy={running}>
                    {running ? "Verifying…" : verification ? "Run Again" : "Verify"}
                  </button>
                ) : (
                  <a href="#local-run-command" className={btnPrimary}>
                    {localRunLabel}
                  </a>
                )}
              </>
            ) : (
              <button type="button" onClick={onGenerate} disabled={busy} className={btnPrimary} aria-busy={busy}>
                {busy ? "Generating…" : "Generate Test"}
              </button>
            )}
          />
        </div>
      </header>

      {!test ? (
        <div className={`${card} space-y-3 p-8 text-center`}>
          <h2 className="text-lg font-semibold">No test generated yet</h2>
          <p className="mx-auto max-w-md text-sm leading-relaxed text-muted">
            A regression test reproduces this bug so it cannot come back unnoticed.
          </p>
          {genError && (
            <div className="mx-auto max-w-md text-left">
              <Notice tone="error" title="Could not generate the test">
                {genError}
              </Notice>
            </div>
          )}
          <button type="button" onClick={onGenerate} disabled={busy} className={`${btnPrimary} mt-2`} aria-busy={busy}>
            {busy ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Generating test…
              </>
            ) : (
              "Generate Test"
            )}
          </button>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-6">
            <CodeBlock
              code={test.code}
              label={test.filename}
              maxHeight="34rem"
            />
            {isTemplate && (
              <Notice tone="warning" title="This test is a template">
                The built-in analyzer could not work out concrete inputs for this bug. Replace the TODO values with the input that triggered the error.
              </Notice>
            )}
          </div>

          <aside className="space-y-6 lg:sticky lg:top-6 lg:self-start">
            <section className={`${card} space-y-3 p-5`}>
              <h2 className="text-base font-semibold">What it covers</h2>
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink/90 marker:text-faint">
                {test.covers.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
              <p className="text-xs text-muted">Framework: {test.framework}</p>
            </section>

            <section className={`${card} space-y-3 p-5`} aria-labelledby="verify-heading">
              <h2 id="verify-heading" className="text-base font-semibold">
                Verify
              </h2>
              {runBlocker ? (
                <>
                  <Notice tone="info" title="Test generated. Run it locally.">
                    {runBlocker}
                  </Notice>
                  <div id="local-run-command" className="space-y-2 rounded-md border border-line bg-code p-3">
                    <p className="text-xs text-muted">Save the test as {test.filename}, then run this from your project root:</p>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <code className="min-w-0 break-all font-mono text-xs text-ink">{localCommand}</code>
                      <CopyButton text={localCommand} label="Copy command" />
                    </div>
                  </div>
                  {(input.language === "Python" || input.language === "Java") && (
                    <p className="text-xs text-muted">
                      {input.language === "Python"
                        ? "Save the code under test as solution.py beside the test file, then replace the TODO values."
                        : "Add JUnit 5 to your Maven project, place the test in src/test/java, then replace the TODO values."}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm leading-relaxed text-muted">
                  The browser runner checks this test against the original code and the suggested fix.
                </p>
              )}
            </section>
          </aside>

          {verification && (
            <section className="space-y-3 lg:col-span-2" aria-labelledby="result-heading" aria-live="polite">
              <h2 id="result-heading" className="text-base font-semibold">
                Verification
              </h2>
              <div className="grid gap-3 md:grid-cols-2">
                <RunRow title="Original code" note="Expected to fail: the test reproduces the bug" report={verification.before} />
                <RunRow title="With the suggested fix" note="Expected to pass" report={verification.after} />
              </div>
              {verified ? (
                <Notice tone="success" title="Verified">
                  The test fails on the original code and passes with the fix, so the fix resolves this bug.
                </Notice>
              ) : !verification.before.ok || !verification.after.ok ? (
                <Notice tone="error" title="The test could not run cleanly">
                  Check the error above. The pasted code may not be valid standalone JavaScript.
                </Notice>
              ) : !beforeFailed ? (
                <Notice tone="warning" title="The test does not reproduce the bug">
                  It passes on your original code, so it would not catch this bug coming back. Adjust the test inputs before relying on it.
                </Notice>
              ) : (
                <Notice tone="warning" title="The fix is not verified">
                  Some tests still fail with the suggested fix. Review the failing tests before applying the fix.
                </Notice>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

export function TestView({ id }: { id: string }) {
  return <RecordGate id={id}>{(record) => <View record={record} />}</RecordGate>;
}

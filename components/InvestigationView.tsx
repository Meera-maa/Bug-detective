"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { generateTest, investigate, UserFacingError } from "@/lib/client/api";
import { attachTest, clearInvestigationDraft, removeRecord, saveInvestigation, saveInvestigationDraft } from "@/lib/storage";
import type { InvestigationRecord } from "@/lib/types";
import { CodeBlock } from "./CodeBlock";
import { Confidence } from "./Confidence";
import { DiffView } from "./DiffView";
import { Inline, Prose } from "./Inline";
import { Notice } from "./Notice";
import { RecordGate } from "./RecordGate";
import { Stepper } from "./Stepper";
import { btnPrimary, btnSecondary, card } from "./ui";
import { isGeneratedTestForLanguage } from "@/lib/validate";

function Section({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <section className={`${card} p-5 sm:p-6`}>
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <span aria-hidden="true">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function View({ record }: { record: InvestigationRecord }) {
  const router = useRouter();
  const { result, input } = record;
  const savedTestIsCompatible = Boolean(record.test && isGeneratedTestForLanguage(input.language, record.test));
  const [busy, setBusy] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onBackToInvestigate() {
    saveInvestigationDraft({
      error: input.error,
      stackTrace: input.stackTrace ?? "",
      code: input.code,
      language: input.language,
      expectedResult: input.expectedResult ?? "",
      actualResult: input.actualResult ?? "",
      showStack: Boolean(input.stackTrace),
      showExpectedActual: Boolean(input.expectedResult || input.actualResult),
    });
    router.push("/");
  }

  function onStartNewInvestigation() {
    removeRecord(record.id);
    clearInvestigationDraft();
    router.replace("/");
  }

  async function onAnalyzeAgain() {
    if (reanalyzing) return;
    setReanalyzing(true);
    setError(null);
    try {
      const { result: nextResult, provider } = await investigate(input);
      const { id } = saveInvestigation(input, nextResult, provider);
      router.push(`/investigation/${id}`);
    } catch (e) {
      setError(e instanceof UserFacingError ? e.message : "The investigation could not be repeated. Please try again.");
      setReanalyzing(false);
    }
  }

  async function onGenerateTest() {
    if (savedTestIsCompatible) return router.push(`/investigation/${record.id}/test`);
    setBusy(true);
    setError(null);
    try {
      const test = await generateTest(input, result);
      attachTest(record.id, test);
      router.push(`/investigation/${record.id}/test`);
    } catch (e) {
      setError(e instanceof UserFacingError ? e.message : "The test could not be generated. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <header className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              <span aria-hidden="true">🕵️ </span>Investigation Result
            </h1>
            <p className="mt-1 text-sm text-muted">
              {record.title} · analysed by {record.provider}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onBackToInvestigate} className={btnSecondary}>
              ← Back
            </button>
            <button type="button" onClick={onStartNewInvestigation} className={btnPrimary}>
              Start New Investigation
            </button>
          </div>
        </div>
        <div className={`${card} space-y-3 px-4 py-4 sm:px-6`}>
          <Stepper
            done={3}
            actions={
              <>
                <button type="button" onClick={onAnalyzeAgain} disabled={reanalyzing} className={btnSecondary} aria-busy={reanalyzing}>
                  {reanalyzing ? "Analyzing…" : "Analyze Again"}
                </button>
                <button type="button" onClick={onGenerateTest} disabled={busy} className={btnPrimary} aria-busy={busy}>
                  {busy ? "Generating…" : savedTestIsCompatible ? "View Test" : record.test ? "Regenerate Test" : "Generate Test"}
                </button>
              </>
            }
          />
          {error && (
            <Notice tone="error" title="Could not complete this action">
              {error}
            </Notice>
          )}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <Section icon="🔴" title="Problem">
            <p className="text-lg leading-snug">
              <Inline text={result.problem} />
            </p>
          </Section>

          <Section icon="📍" title="Likely Root Cause">
            <Prose text={result.rootCause} />
          </Section>

          <Section icon="🔎" title="Evidence">
            <ol className="space-y-3">
              {result.evidence.map((item, i) => (
                <li key={i} className="flex gap-3 text-[15px] leading-relaxed text-ink/90">
                  <span className="mt-0.5 w-5 shrink-0 text-right font-mono text-sm text-faint">{i + 1}.</span>
                  <span>
                    <Inline text={item} />
                  </span>
                </li>
              ))}
            </ol>
          </Section>

          <Section icon="💡" title="Suggested Fix">
            <div className="space-y-5">
              <Prose text={result.suggestedFix} />
              {result.fixedCode ? (
                <DiffView before={input.code} after={result.fixedCode} />
              ) : (
                <>
                  <Notice tone="info" title="No automatic fix for this one">
                    The code was not rewritten because the fix cannot be made safely from this input alone. Your original code is shown below for reference.
                  </Notice>
                  <CodeBlock code={input.code} label="your code" />
                </>
              )}
            </div>
          </Section>

          <details className={`${card} group`}>
            <summary className="cursor-pointer select-none rounded-lg px-5 py-3.5 text-sm font-medium text-muted hover:text-ink sm:px-6">
              What you submitted
            </summary>
            <div className="space-y-4 border-t border-line p-5 sm:p-6">
              <CodeBlock code={input.error} label="error message" maxHeight="12rem" />
              {input.stackTrace && <CodeBlock code={input.stackTrace} label="stack trace" maxHeight="12rem" />}
              <CodeBlock code={input.code} label={`your code (${input.language})`} />
            </div>
          </details>
        </div>

        <aside className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <section className={`${card} p-5`} aria-labelledby="conf-heading">
            <h2 id="conf-heading" className="mb-3 flex items-center gap-2 text-base font-semibold">
              <span aria-hidden="true">📊</span>Confidence
            </h2>
            <Confidence level={result.confidence} />
          </section>

          <section className={`${card} space-y-3 p-5`} aria-labelledby="next-heading">
            <h2 id="next-heading" className="text-base font-semibold">
              Regression test
            </h2>
            <p className="text-sm leading-relaxed text-muted">
              <Inline text={result.testSuggestion} />
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function InvestigationView({ id }: { id: string }) {
  return <RecordGate id={id}>{(record) => <View record={record} />}</RecordGate>;
}

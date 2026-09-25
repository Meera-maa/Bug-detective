"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DEMOS } from "@/lib/demos";
import { investigate, UserFacingError } from "@/lib/client/api";
import { saveInvestigation } from "@/lib/storage";
import { LANGUAGES, type Language } from "@/lib/types";
import { LIMITS, parseInvestigationInput } from "@/lib/validate";
import { Notice } from "./Notice";
import { RecentInvestigations } from "./RecentInvestigations";
import { btnPrimary, btnSecondary, card, fieldBase } from "./ui";

type FieldErrors = { error?: string; code?: string; stackTrace?: string; expectedResult?: string; actualResult?: string };

function validate(error: string, stackTrace: string, code: string, expectedResult: string, actualResult: string): FieldErrors {
  const errors: FieldErrors = {};
  if (!error.trim()) errors.error = "Paste the error message you are seeing.";
  else if (error.length > LIMITS.error) errors.error = `Too long (max ${LIMITS.error} characters).`;
  if (!code.trim()) errors.code = "Paste the code where the error happens.";
  else if (code.length > LIMITS.code) errors.code = `Too long (max ${LIMITS.code} characters). Paste only the relevant part.`;
  if (stackTrace.length > LIMITS.stackTrace) errors.stackTrace = `Too long (max ${LIMITS.stackTrace} characters).`;
  if (expectedResult.length > LIMITS.expectedResult) errors.expectedResult = `Too long (max ${LIMITS.expectedResult} characters).`;
  if (actualResult.length > LIMITS.actualResult) errors.actualResult = `Too long (max ${LIMITS.actualResult} characters).`;
  return errors;
}

export function HomeWorkspace() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [stackTrace, setStackTrace] = useState("");
  const [code, setCode] = useState("");
  const [language, setLanguage] = useState<Language>("JavaScript");
  const [showStack, setShowStack] = useState(false);
  const [showExpectedActual, setShowExpectedActual] = useState(false);
  const [expectedResult, setExpectedResult] = useState("");
  const [actualResult, setActualResult] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [slow, setSlow] = useState(false);
  const [activeDemo, setActiveDemo] = useState<string | null>(null);
  const errorRef = useRef<HTMLTextAreaElement>(null);
  const codeRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [loading]);

  function loadDemo(id: string) {
    const demo = DEMOS.find((d) => d.id === id);
    if (!demo) return;
    setError(demo.input.error);
    setStackTrace(demo.input.stackTrace ?? "");
    setShowStack(Boolean(demo.input.stackTrace));
    setCode(demo.input.code);
    setLanguage(demo.input.language);
    setExpectedResult("");
    setActualResult("");
    setShowExpectedActual(false);
    setFieldErrors({});
    setServerError(null);
    setActiveDemo(id);
  }

  function clearAll() {
    setError("");
    setStackTrace("");
    setCode("");
    setExpectedResult("");
    setActualResult("");
    setShowExpectedActual(false);
    setFieldErrors({});
    setServerError(null);
    setActiveDemo(null);
    errorRef.current?.focus();
  }

  async function onInvestigate() {
    if (loading) return;
    setServerError(null);
    const errors = validate(error, stackTrace, code, expectedResult, actualResult);
    setFieldErrors(errors);
    if (errors.error) return errorRef.current?.focus();
    if (errors.code) return codeRef.current?.focus();

    const parsed = parseInvestigationInput({ error, stackTrace, code, language, expectedResult, actualResult });
    if (!parsed.ok) return setServerError(parsed.message);

    setLoading(true);
    setSlow(false);
    try {
      const { result, provider } = await investigate(parsed.value);
      const { id } = saveInvestigation(parsed.value, result, provider);
      router.push(`/investigation/${id}`); // keep the loading state until the page changes
    } catch (e) {
      setServerError(e instanceof UserFacingError ? e.message : "Investigation could not be completed. Please check your input or try again.");
      setLoading(false);
    }
  }

  function onTab(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Let Tab indent inside the code box, like a code editor. Escape then Tab leaves the box.
    if (e.key !== "Tab" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: end } = el;
    setCode(`${code.slice(0, s)}  ${code.slice(end)}`);
    requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
  }

  function onShortcut(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void onInvestigate();
    }
  }

  const empty = !error.trim() && !code.trim() && !stackTrace.trim() && !expectedResult.trim() && !actualResult.trim();

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className={`${card} p-5 sm:p-6`}>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <h2 className="text-xl font-semibold tracking-tight">What went wrong?</h2>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Load a demo bug">
            <span className="text-sm text-muted">Try a demo bug:</span>
            {DEMOS.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => loadDemo(d.id)}
                title={d.hint}
                aria-pressed={activeDemo === d.id}
                disabled={loading}
                className={`rounded-full border px-3 py-1 text-[13px] transition-colors disabled:opacity-50 ${
                  activeDemo === d.id ? "border-accent bg-accent/10 text-ink" : "border-line-strong text-muted hover:border-faint hover:text-ink"
                }`}
              >
                {d.title}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-5" onKeyDown={onShortcut}>
          <div>
            <label htmlFor="error" className="mb-1.5 block text-sm font-medium">
              Error message
            </label>
            <textarea
              id="error"
              ref={errorRef}
              rows={3}
              value={error}
              onChange={(e) => {
                setError(e.target.value);
                if (fieldErrors.error) setFieldErrors((f) => ({ ...f, error: undefined }));
              }}
              placeholder="TypeError: Cannot read properties of undefined (reading 'name')"
              spellCheck={false}
              aria-invalid={Boolean(fieldErrors.error)}
              aria-describedby={fieldErrors.error ? "error-msg" : undefined}
              className={`${fieldBase} font-mono ${fieldErrors.error ? "border-danger" : ""}`}
            />
            {fieldErrors.error && (
              <p id="error-msg" className="mt-1.5 text-sm text-danger">
                {fieldErrors.error}
              </p>
            )}
            <p className="mt-1.5 text-xs text-faint">Tip: paste the API response or the bad data here too, if the error involves one.</p>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <label htmlFor="code" className="text-sm font-medium">
                Paste relevant code
              </label>
              <div className="flex items-center gap-2">
                <label htmlFor="language" className="text-sm text-muted">
                  Language
                </label>
                <select
                  id="language"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as Language)}
                  className="rounded-md border border-line bg-code px-2 py-1 text-sm text-ink focus:border-accent focus:ring-1 focus:ring-accent"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <textarea
              id="code"
              ref={codeRef}
              rows={12}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                if (fieldErrors.code) setFieldErrors((f) => ({ ...f, code: undefined }));
              }}
              onKeyDown={onTab}
              placeholder={"function getUserName(data) {\n  const user = data.user;\n  return user.name;\n}"}
              spellCheck={false}
              wrap="off"
              aria-invalid={Boolean(fieldErrors.code)}
              aria-describedby={fieldErrors.code ? "code-msg" : undefined}
              className={`${fieldBase} scroll-thin resize-y font-mono leading-6 ${fieldErrors.code ? "border-danger" : ""}`}
            />
            {fieldErrors.code && (
              <p id="code-msg" className="mt-1.5 text-sm text-danger">
                {fieldErrors.code}
              </p>
            )}
            {language === "Python" && (
              <p className="mt-1.5 text-xs text-faint">
                The built-in analyzer has partial Python support (IndexError, KeyError, TypeError, NameError, AttributeError, ZeroDivisionError, ValueError). For unrecognised errors it provides general guidance.
              </p>
            )}
            {language === "Java" && (
              <p className="mt-1.5 text-xs text-faint">
                The built-in analyzer has partial Java support (NullPointerException, ArrayIndexOutOfBoundsException, NumberFormatException, ArithmeticException, ClassCastException). For unrecognised errors it provides general guidance.
              </p>
            )}
            {language === "Other" && (
              <p className="mt-1.5 text-xs text-faint">
                The built-in analyzer understands JavaScript, TypeScript, Python, and Java patterns. For other languages it provides general guidance based on the error message and stack trace.
              </p>
            )}
          </div>

          <div>
            {showStack ? (
              <>
                <div className="mb-1.5 flex items-center justify-between">
                  <label htmlFor="stack" className="text-sm font-medium">
                    Stack trace <span className="font-normal text-muted">(optional)</span>
                  </label>
                  <button type="button" className="text-xs text-muted hover:text-ink" onClick={() => setShowStack(false)}>
                    Hide
                  </button>
                </div>
                <textarea
                  id="stack"
                  rows={4}
                  value={stackTrace}
                  onChange={(e) => setStackTrace(e.target.value)}
                  placeholder={"    at getUserName (login.js:3:15)\n    at handleLogin (login.js:9:20)"}
                  spellCheck={false}
                  wrap="off"
                  className={`${fieldBase} scroll-thin resize-y font-mono leading-6`}
                />
                {fieldErrors.stackTrace && <p className="mt-1.5 text-sm text-danger">{fieldErrors.stackTrace}</p>}
              </>
            ) : (
              <button type="button" className="text-sm text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setShowStack(true)}>
                + Add a stack trace {stackTrace.trim() ? "(has content)" : "(optional)"}
              </button>
            )}
          </div>

          <div>
            {showExpectedActual ? (
  <>
    <div className="mb-1.5 flex items-center justify-between">
      <label htmlFor="expectedResult" className="text-sm font-medium">
        Expected result <span className="font-normal text-muted">(optional)</span>
      </label>
      <button
        type="button"
        className="text-xs text-muted hover:text-ink"
        onClick={() => setShowExpectedActual(false)}
      >
        Hide
      </button>
    </div>

    <input
      id="expectedResult"
      value={expectedResult}
      onChange={(e) => setExpectedResult(e.target.value)}
      placeholder="Example: 13"
      className={fieldBase}
    />

    <div className="mt-3 mb-1.5">
      <label htmlFor="actualResult" className="text-sm font-medium">
        Actual result <span className="font-normal text-muted">(optional)</span>
      </label>
    </div>

    <input
      id="actualResult"
      value={actualResult}
      onChange={(e) => setActualResult(e.target.value)}
      placeholder="Example: 30"
      className={fieldBase}
    />

    {fieldErrors.expectedResult && (
      <p className="mt-1.5 text-sm text-danger">{fieldErrors.expectedResult}</p>
    )}

    {fieldErrors.actualResult && (
      <p className="mt-1.5 text-sm text-danger">{fieldErrors.actualResult}</p>
    )}
  </>
) : (
  <button
    type="button"
    className="text-sm text-muted underline-offset-2 hover:text-ink hover:underline"
    onClick={() => setShowExpectedActual(true)}
  >
    + Add expected & actual result (optional)
  </button>
)}
          </div>

          {serverError && (
            <Notice tone="error" title="Investigation could not be completed">
              {serverError}
            </Notice>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={onInvestigate} disabled={loading} className={btnPrimary} aria-busy={loading}>
              {loading ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Investigating…
                </>
              ) : (
                <>🔍 Investigate</>
              )}
            </button>
            {!empty && !loading && (
              <button type="button" onClick={clearAll} className={btnSecondary}>
                Clear
              </button>
            )}
            <span className="hidden text-xs text-faint sm:inline">or press Ctrl/⌘ + Enter</span>
          </div>

          <p className="min-h-5 text-sm text-muted" role="status" aria-live="polite">
            {loading && (slow ? "Still working. Larger code can take a little longer." : "Reading the error, the stack trace and the code…")}
          </p>
        </div>
      </div>

      <aside className="lg:sticky lg:top-6 lg:self-start">
        <RecentInvestigations />
      </aside>
    </div>
  );
}

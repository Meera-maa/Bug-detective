"use client";

import { useSyncExternalStore } from "react";
import { LANGUAGES, type GeneratedTest, type InvestigationInput, type InvestigationRecord, type InvestigationResult, type Language, type Severity } from "./types";
import { parseGeneratedTest, parseInvestigationInput, parseInvestigationResult } from "./validate";

/**
 * Recent investigations live in localStorage only (no database).
 * Every read is defensive: private mode, a full disk or hand-edited data must never break the app.
 */

const KEY = "bug-detective:v1:history";
const DRAFT_KEY = "bug-detective:v1:investigation-draft";
const MAX_RECORDS = 20;
const EMPTY: InvestigationRecord[] = [];
const EMPTY_DRAFT: InvestigationDraft = {
  error: "",
  stackTrace: "",
  code: "",
  language: "JavaScript",
  expectedResult: "",
  actualResult: "",
  showStack: false,
  showExpectedActual: false,
};

export type InvestigationDraft = {
  error: string;
  stackTrace: string;
  code: string;
  language: Language;
  expectedResult: string;
  actualResult: string;
  showStack: boolean;
  showExpectedActual: boolean;
};

const listeners = new Set<() => void>();
const draftListeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cachedValue: InvestigationRecord[] = EMPTY;
let cachedDraftRaw: string | null | undefined;
let cachedDraft: InvestigationDraft | null = null;
let draftFallback: InvestigationDraft | null | undefined;
/** Used only when localStorage is blocked or full, so the current session still works. */
let memoryFallback: InvestigationRecord[] | null = null;

function readRaw(): string {
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function parseRecords(raw: string): InvestigationRecord[] {
  if (!raw) return EMPTY;
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return EMPTY;
    const out: InvestigationRecord[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Record<string, unknown>;
      const input = parseInvestigationInput(r.input);
      const result = parseInvestigationResult(r.result);
      if (typeof r.id !== "string" || !input.ok || !result.ok) continue;
      const test = r.test === undefined ? undefined : parseGeneratedTest(r.test);
      out.push({
        id: r.id,
        createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date(0).toISOString(),
        title: typeof r.title === "string" ? r.title : "Investigation",
        severity: r.severity === "orange" || r.severity === "yellow" ? r.severity : "red",
        provider: typeof r.provider === "string" ? r.provider : "Unknown",
        input: input.value,
        result: result.value,
        ...(test?.ok ? { test: test.value } : {}),
      });
    }
    return out;
  } catch {
    return EMPTY;
  }
}

function getSnapshot(): InvestigationRecord[] {
  if (memoryFallback) return memoryFallback;
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedValue = parseRecords(raw);
  }
  return cachedValue;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  window.addEventListener("storage", callback); // other tabs
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

function write(records: InvestigationRecord[]): boolean {
  const trimmed = records.slice(0, MAX_RECORDS);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(trimmed));
    memoryFallback = null;
    listeners.forEach((l) => l());
    return true;
  } catch {
    // Storage full or blocked: keep the session working from memory. History will not survive a reload.
    memoryFallback = trimmed;
    listeners.forEach((l) => l());
    return false;
  }
}

const noopSubscribe = () => () => {};

/** All saved investigations, newest first. `ready` is false during server render / first paint. */
export function useHistory(): { records: InvestigationRecord[]; ready: boolean } {
  const records = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
  const ready = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return { records, ready };
}

export function useRecord(id: string): { record: InvestigationRecord | undefined; ready: boolean } {
  const { records, ready } = useHistory();
  return { record: records.find((r) => r.id === id), ready };
}

function newId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${random}`;
}

export function severityFor(error: string): Severity {
  if (/\b5\d\d\b|ECONN|ETIMEDOUT|timeout|server/i.test(error)) return "orange";
  if (/TypeError|ReferenceError|SyntaxError|RangeError|Uncaught|Exception/i.test(error)) return "red";
  return "yellow";
}

export function makeTitle(input: InvestigationInput): string {
  const first = (input.error.split("\n").find((l) => l.trim()) ?? "Error").trim();
  const kind = /^([A-Za-z]*(?:Error|Exception))\b/.exec(first)?.[1];
  const fn = /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>))/.exec(input.code);
  const name = fn?.[1] ?? fn?.[2];
  if (kind && name) return `${kind} in ${name}`;
  return first.length > 48 ? `${first.slice(0, 47)}…` : first;
}

/** Saves a finished investigation and returns its id. */
export function saveInvestigation(input: InvestigationInput, result: InvestigationResult, provider: string): { id: string; saved: boolean } {
  const record: InvestigationRecord = {
    id: newId(),
    createdAt: new Date().toISOString(),
    title: makeTitle(input),
    severity: severityFor(input.error),
    provider,
    input,
    result,
  };
  const saved = write([record, ...getSnapshot()]);
  return { id: record.id, saved };
}

export function attachTest(id: string, test: GeneratedTest): boolean {
  return write(getSnapshot().map((r) => (r.id === id ? { ...r, test } : r)));
}

export function clearHistory(): void {
  write([]);
}

export function removeRecord(id: string): void {
  write(getSnapshot().filter((r) => r.id !== id));
}

function parseDraft(raw: string | null): InvestigationDraft | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const draft = value as Record<string, unknown>;
    if (
      typeof draft.error !== "string" ||
      typeof draft.stackTrace !== "string" ||
      typeof draft.code !== "string" ||
      typeof draft.language !== "string" ||
      !(LANGUAGES as readonly string[]).includes(draft.language) ||
      typeof draft.expectedResult !== "string" ||
      typeof draft.actualResult !== "string"
    ) return null;
    return {
      error: draft.error,
      stackTrace: draft.stackTrace,
      code: draft.code,
      language: draft.language as Language,
      expectedResult: draft.expectedResult,
      actualResult: draft.actualResult,
      showStack: draft.showStack === true,
      showExpectedActual: draft.showExpectedActual === true,
    };
  } catch {
    return null;
  }
}

function getDraftSnapshot(): InvestigationDraft | null {
  if (draftFallback !== undefined) return draftFallback;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(DRAFT_KEY);
  } catch {
    return null;
  }
  if (raw !== cachedDraftRaw) {
    cachedDraftRaw = raw;
    cachedDraft = parseDraft(raw);
  }
  return cachedDraft;
}

function subscribeDraft(callback: () => void): () => void {
  draftListeners.add(callback);
  return () => draftListeners.delete(callback);
}

/** The current investigation form draft, with an empty server snapshot for hydration. */
export function useInvestigationDraft(): InvestigationDraft | null {
  return useSyncExternalStore(subscribeDraft, getDraftSnapshot, () => null);
}

export function saveInvestigationDraft(draft: InvestigationDraft): void {
  try {
    const raw = JSON.stringify(draft);
    window.sessionStorage.setItem(DRAFT_KEY, raw);
    cachedDraftRaw = raw;
  } catch {
    // The form remains usable when browser storage is unavailable.
  }
  cachedDraft = draft;
  draftFallback = draft;
  draftListeners.forEach((listener) => listener());
}

export function getInvestigationDraft(): InvestigationDraft | null {
  return getDraftSnapshot();
}

export function updateInvestigationDraft(changes: Partial<InvestigationDraft>): void {
  saveInvestigationDraft({ ...(getDraftSnapshot() ?? EMPTY_DRAFT), ...changes });
}

export function clearInvestigationDraft(): void {
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Ignore blocked browser storage.
  }
  cachedDraftRaw = null;
  cachedDraft = null;
  draftFallback = null;
  draftListeners.forEach((listener) => listener());
}

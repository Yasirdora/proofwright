/**
 * The verdicts: what breaking the app did to each test.
 *
 * A proof runs the tests once with nothing broken (the clean run), then once
 * per fault — one call broken for the whole run, every answer late, or (for a
 * step a test repeats) only the 2nd, 3rd … answer late and changed. For each
 * test, the faults on calls it makes itself are what count:
 *
 *   caught     — it failed on every try while the call was broken
 *   missed     — it passed (on any try) while the call was broken: it can pass
 *                with the app broken there
 *   not tried  — it didn't run with the call broken (an earlier test in its
 *                serial group failed first, or the fault had nothing to break)
 *
 * The verdict, in the order the rules are tried:
 *   not proven — marked to fail · already fails with nothing broken · flaky ·
 *                makes no API calls · none of its calls were broken · never ran
 *                with one broken
 *   misses its own action — it passed while a call its own step makes
 *                (POST, PUT, PATCH, DELETE) failed, or while the answers to a
 *                repeat of that step came late and different
 *   can't fail — nothing broken made it fail
 *   catches    — it failed when its calls broke
 *
 * Each verdict comes with a result and a "what to do" in plain words. A test
 * that already fails is never something to "fix" to make it pass: it may be
 * failing on a bug in the app.
 */
import * as path from "node:path";
import type { FaultKind } from "./proxy.js";

export type Verdict = "misses its own action" | "can't fail" | "catches" | "not proven";
export type Outcome = "caught" | "missed" | "not tried";

export interface TestCall {
  endpoint: string;
  action: boolean;
}

/** The step in the test that made a call: `click "Apply"` at file:line. */
export interface StepRef {
  name: string;
  /** "demo/generated/coupons-cart.spec.ts:264" */
  at: string;
}

export interface CleanResult {
  id: string;
  title: string;
  file: string;
  line: number;
  /** Final status in the clean run. */
  status: "passed" | "failed" | "flaky";
  /** Each try's status in the clean run. */
  attempts: string[];
  /** It's marked test.fail(). */
  expectedToFail: boolean;
  error?: string;
  /** The API calls it made in the clean run. */
  calls: TestCall[];
}

/** Project-relative paths of what Playwright kept from that run. */
export interface CellEvidence {
  screenshot?: string;
  trace?: string;
}

export interface FaultRun {
  kind: FaultKind;
  /** The endpoints broken; every API call when absent (only for slow). */
  endpoints?: string[];
  /** Only this call of the endpoint was broken (1 = the first). */
  nth?: number;
  /** The run held only this test. */
  test?: string;
  /** The fault broke at least one call — false when it had nothing to break. */
  applied: boolean;
  /** What each test did in it, by test id. A test that isn't here wasn't run. */
  results: Record<string, { attempts: string[]; error?: string; errorAt?: string; evidence?: CellEvidence }>;
}

export interface Cell {
  /** The endpoint broken; absent for a fault on every call. */
  endpoint?: string;
  kind: FaultKind;
  nth?: number;
  outcome: Outcome;
  attempts: string[];
  error?: string;
  errorAt?: string;
  evidence?: CellEvidence;
}

export interface ProvenTest {
  id: string;
  title: string;
  file: string;
  line: number;
  verdict: Verdict;
  /** The result, in one or two short sentences. */
  result: string;
  /** What a person should do about it; empty when nothing. */
  todo: string;
  calls: TestCall[];
  caught: Cell[];
  missed: Cell[];
  notTried: Cell[];
  /** Faults on calls it doesn't make that failed it anyway. */
  alsoFailed: Cell[];
  /** The run where every answer came late, when there was one. */
  slow?: Cell;
}

/** How each fault reads in a sentence: "“Apply” fails". */
export const FAULT_PHRASE: Record<FaultKind, string> = {
  error: "fails",
  empty: "answers with empty lists",
  malformed: "answers with broken data",
  slow: "answers late",
  changed: "and the answers after it come late and different",
};

export function outcomeOf(attempts: string[] | undefined): Outcome {
  if (!attempts || attempts.length === 0) return "not tried";
  if (attempts.includes("passed")) return "missed";
  if (attempts.some((a) => a === "failed" || a === "timedOut")) return "caught";
  return "not tried";
}

/** Failed and then passed, with nothing changed between the tries. */
export const mixed = (attempts: string[]) => attempts.includes("passed") && attempts.some((a) => a === "failed" || a === "timedOut");

export interface JudgeOptions {
  /** How an endpoint is shown when no step is known: "POST /api/cart/coupon". */
  name?: (endpoint: string) => string;
  /** The step that made the n-th call to an endpoint in a test, when the trace says. */
  step?: (testId: string, endpoint: string, nth: number) => StepRef | undefined;
  /** The tester limited the proof to some endpoints. */
  limited?: boolean;
  /** The app made no server calls at all: there was nothing to break. */
  noCalls?: boolean;
}

const ORDINAL = ["", "", "2nd ", "3rd ", "4th ", "5th "];

export function judge(clean: CleanResult[], runs: FaultRun[], options: JudgeOptions = {}): ProvenTest[] {
  const name = options.name ?? ((e: string) => e);

  /** `"Apply"` (line 264) — or `POST /api/cart/coupon` when no step is known. */
  const thing = (testId: string, cell: Cell): { label: string; at: string } => {
    if (!cell.endpoint) return { label: "every call", at: "" };
    const step = options.step?.(testId, cell.endpoint, cell.nth ?? 1);
    if (!step) return { label: `${ORDINAL[cell.nth ?? 0] ?? `${cell.nth}th `}${name(cell.endpoint)}`, at: "" };
    const target = /^click (".*")$/.exec(step.name)?.[1] ?? step.name;
    return { label: `${cell.nth && cell.nth > 1 ? `the ${ORDINAL[cell.nth] ?? `${cell.nth}th `}` : ""}${target}`, at: ` (${path.basename(step.at)})` };
  };
  const sentence = (testId: string, cells: Cell[], max = 2) => {
    const parts = [...new Set(cells.map((c) => `${thing(testId, c).label} ${FAULT_PHRASE[c.kind]}`))];
    return parts.slice(0, max).join(", or when ") + (parts.length > max ? ` (and ${parts.length - max} more)` : "");
  };

  return clean.map((t) => {
    const own = new Set(t.calls.map((c) => c.endpoint));
    const actions = new Set(t.calls.filter((c) => c.action).map((c) => c.endpoint));
    const proven: ProvenTest = {
      id: t.id,
      title: t.title,
      file: t.file,
      line: t.line,
      verdict: "not proven",
      result: "",
      todo: "",
      calls: t.calls,
      caught: [],
      missed: [],
      notTried: [],
      alsoFailed: [],
    };
    let flakyRuns = mixed(t.attempts) ? 1 : 0;

    for (const run of runs) {
      if (run.test !== undefined && run.test !== t.id) continue;
      const r = run.results[t.id];
      const cell: Cell = {
        ...(run.endpoints?.length === 1 ? { endpoint: run.endpoints[0] } : {}),
        kind: run.kind,
        ...(run.nth ? { nth: run.nth } : {}),
        outcome: run.applied ? outcomeOf(r?.attempts) : "not tried",
        attempts: r?.attempts ?? [],
        ...(r?.error ? { error: r.error } : {}),
        ...(r?.errorAt ? { errorAt: r.errorAt } : {}),
        ...(r?.evidence ? { evidence: r.evidence } : {}),
      };
      if (r && mixed(r.attempts)) flakyRuns++;
      // Late answers are a finding of their own, whichever calls were late.
      if (run.kind === "slow") {
        proven.slow = cell;
        continue;
      }
      if ((run.endpoints ?? []).some((e) => own.has(e))) {
        proven[cell.outcome === "caught" ? "caught" : cell.outcome === "missed" ? "missed" : "notTried"].push(cell);
      } else if (cell.outcome === "caught") {
        proven.alsoFailed.push(cell);
      }
    }

    const depends =
      proven.alsoFailed.length > 0
        ? ` It also fails when ${sentence(t.id, proven.alsoFailed, 1)}, a call it doesn't make: it depends on another test.`
        : "";
    const brokenOwn = proven.caught.length + proven.missed.length + proven.notTried.length;
    const missedActions = proven.missed.filter((c) => c.endpoint && actions.has(c.endpoint) && (c.kind === "error" || c.kind === "changed"));

    const notProven = (result: string, todo = "") => {
      proven.result = result;
      proven.todo = todo;
    };
    if (t.expectedToFail) {
      notProven("Marked to fail (test.fail), so a failure proves nothing about it.");
    } else if (t.status === "failed") {
      notProven(
        `Can't be checked: it already fails with nothing broken${t.error ? ` (${t.error})` : ""}.`,
        "Find out why with explain. If the app is wrong, report the bug — don't change the test to make it pass. Prove it again once it passes.",
      );
    } else if (flakyRuns > 0) {
      notProven(
        `Can't be checked: it passes and fails at random, with nothing changed (${flakyRuns === 1 ? "once" : `${flakyRuns} times`}).`,
        "Make it stable first (explain shows where to look), then prove it again.",
      );
    } else if (t.calls.length === 0 && options.noCalls) {
      notProven("Not checked: the app made no server calls, so there was nothing to break.");
    } else if (t.calls.length === 0) {
      notProven(
        `Can't be checked alone: it makes no API calls of its own.${proven.alsoFailed.length > 0 ? ` It fails when ${sentence(t.id, proven.alsoFailed, 1)}: it reads another test's result.` : ""}`,
      );
    } else if (brokenOwn === 0) {
      notProven(options.limited ? "Not checked: none of its calls were among the ones you asked me to break." : "Not checked: none of its calls could be broken.");
    } else if (proven.caught.length === 0 && proven.missed.length === 0) {
      notProven("Can't be checked: each time, a test before it in its group failed first.");
    } else if (missedActions.length > 0) {
      proven.verdict = "misses its own action";
      const late = missedActions.find((c) => c.kind === "changed");
      const failed = missedActions.find((c) => c.kind === "error");
      if (failed) {
        const { label, at } = thing(t.id, failed);
        proven.result = `Stays green when ${label}${at} fails.${late ? ` Also when the answers to ${thing(t.id, late).label} come late and different.` : ""}${depends}`;
        proven.todo = `After that step, check something the page shows only when ${label} worked.`;
      } else {
        const { label, at } = thing(t.id, late!);
        proven.result = `Stays green when the answers to ${label}${at} come late and different: it checks the page before they arrive.${depends}`;
        proven.todo = `Wait until the page has updated after ${label} before checking it — for example, for a message it shows, or for the data it loads again.`;
      }
    } else if (proven.caught.length === 0) {
      proven.verdict = "can't fail";
      proven.result = `Nothing I broke made it fail: it checks nothing its calls change.${depends}`;
      proven.todo = "Add a check on what the page shows after its main step.";
    } else {
      proven.verdict = "catches";
      const shown = [...proven.caught].sort((a, b) => Number(actions.has(b.endpoint ?? "")) - Number(actions.has(a.endpoint ?? "")));
      proven.result = `Fails when ${sentence(t.id, shown)}.${depends}`;
    }
    return proven;
  });
}

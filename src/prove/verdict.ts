/**
 * The verdicts: what breaking the app did to each test.
 *
 * A proof runs the tests once with nothing broken (the clean run), then once
 * per fault — one call broken for the whole run, or every answer late. For each
 * test, the faults on calls it makes itself are what count:
 *
 *   caught     — it failed on every try while the call was broken
 *   missed     — it passed (on any try) while the call was broken: it can pass
 *                with the app broken there
 *   not tried  — it didn't run (an earlier test in its serial group failed first)
 *
 * A fault on a call it doesn't make can still fail it; that says it depends on
 * another test, or is flaky, and is reported beside the verdict.
 *
 * The verdict, in the order the rules are tried:
 *   not proven — marked to fail · failed in the clean run · flaky (failed then
 *                passed with nothing changed) · makes no API calls · none of its
 *                calls were among those broken · never ran with one broken
 *   passes when its own action fails — it passed while a call that changes
 *                something (POST, PUT, PATCH, DELETE) failed with a server error
 *   can't fail — nothing broken made it fail
 *   catches    — it failed when its calls broke, including its own actions
 */
import type { FaultKind } from "./proxy.js";

export type Verdict = "catches" | "passes when its own action fails" | "can't fail" | "not proven";
export type Outcome = "caught" | "missed" | "not tried";

export interface TestCall {
  endpoint: string;
  action: boolean;
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

export interface FaultRun {
  kind: FaultKind;
  /** The endpoints broken; every API call when absent (only for slow). */
  endpoints?: string[];
  /** What each test did in it, by test id. A test that isn't here wasn't run. */
  results: Record<string, { attempts: string[]; error?: string; errorAt?: string; evidence?: CellEvidence }>;
}

/** Project-relative paths of what Playwright kept from that run. */
export interface CellEvidence {
  screenshot?: string;
  trace?: string;
}

export interface Cell {
  /** The endpoint broken; absent for a fault on every call. */
  endpoint?: string;
  kind: FaultKind;
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
  /** One sentence, for the tester. */
  reason: string;
  calls: TestCall[];
  caught: Cell[];
  missed: Cell[];
  notTried: Cell[];
  /** Faults on calls it doesn't make that failed it anyway. */
  alsoFailed: Cell[];
  /** The run where every answer came late, when there was one. */
  slow?: Cell;
}

/** How each fault reads in a sentence: "POST /api/cart/coupon fails with a server error". */
export const FAULT_PHRASE: Record<FaultKind, string> = {
  error: "fails with a server error",
  empty: "answers with empty lists",
  malformed: "answers with broken data",
  slow: "answers late",
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
  /** How an endpoint is shown: "POST /api/cart/coupon". */
  name?: (endpoint: string) => string;
  /** The tester limited the proof to these endpoints. */
  limited?: boolean;
}

export function judge(clean: CleanResult[], runs: FaultRun[], options: JudgeOptions = {}): ProvenTest[] {
  const name = options.name ?? ((e: string) => e);
  const list = (cells: Cell[], max = 2) => {
    const names = [...new Set(cells.map((c) => `${name(c.endpoint ?? "every call")} ${FAULT_PHRASE[c.kind]}`))];
    return names.slice(0, max).join("; ") + (names.length > max ? ` (and ${names.length - max} more)` : "");
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
      reason: "",
      calls: t.calls,
      caught: [],
      missed: [],
      notTried: [],
      alsoFailed: [],
    };
    let flakyRuns = mixed(t.attempts) ? 1 : 0;

    for (const run of runs) {
      const r = run.results[t.id];
      const cell: Cell = {
        ...(run.endpoints?.length === 1 ? { endpoint: run.endpoints[0] } : {}),
        kind: run.kind,
        outcome: outcomeOf(r?.attempts),
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

    const dependsNote =
      proven.alsoFailed.length > 0
        ? ` It also fails when ${list(proven.alsoFailed)}, ${proven.alsoFailed.length === 1 ? "a call it doesn't make" : "calls it doesn't make"}: it depends on another test.`
        : "";
    const brokenOwn = proven.caught.length + proven.missed.length + proven.notTried.length;
    const missedActions = proven.missed.filter((c) => c.kind === "error" && c.endpoint && actions.has(c.endpoint));

    if (t.expectedToFail) {
      proven.reason = "It's marked to fail (test.fail), so a failure proves nothing about it.";
    } else if (t.status === "failed") {
      proven.reason = `It failed with nothing broken${t.error ? `: ${t.error}` : ""}. Fix that first, then prove it again.`;
    } else if (flakyRuns > 0) {
      proven.reason = `It failed and then passed with nothing changed (${flakyRuns === 1 ? "once" : `${flakyRuns} times`}): it's flaky. Fix that first, then prove it again.`;
    } else if (t.calls.length === 0) {
      proven.reason = `It makes no API calls of its own, so there was nothing of its own to break.${proven.alsoFailed.length > 0 ? ` It fails when ${list(proven.alsoFailed)}: it reads another test's result.` : ""}`;
    } else if (brokenOwn === 0) {
      proven.reason = options.limited
        ? "None of the calls it makes were among the ones you asked me to break."
        : "None of its calls could be broken.";
    } else if (proven.caught.length === 0 && proven.missed.length === 0) {
      proven.reason = "It never ran with one of its calls broken: each time, a test before it in its serial group failed first.";
    } else if (missedActions.length > 0) {
      proven.verdict = "passes when its own action fails";
      proven.reason = `It still passes when ${list(missedActions)}.${dependsNote}`;
    } else if (proven.caught.length === 0) {
      proven.verdict = "can't fail";
      proven.reason = `Nothing I broke made it fail: it passed with ${proven.missed.length === 1 ? "that fault" : `each of ${proven.missed.length} faults`} on the calls it makes.${dependsNote}`;
    } else {
      proven.verdict = "catches";
      proven.reason = `It fails when ${list(proven.caught)}.${dependsNote}`;
    }
    return proven;
  });
}

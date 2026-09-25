/**
 * A proof: run the tests with the app broken on purpose, and see which notice.
 *
 *   1. The clean run — Playwright's runner, the tester's config through the
 *      wrapper (wrapper.ts), one test at a time, no retries, `--forbid-only`.
 *      The fault proxy (proxy.ts) logs every call; a call belongs to the last
 *      test that started before it, so each test's API calls are known.
 *   2. The fault runs — one per endpoint and fault: a server error for every
 *      endpoint; for a read whose answer holds lists, empty lists (and broken
 *      data, when asked); then one run with every answer late. Each runs only
 *      the files whose tests make that call, in the tester's usual way
 *      (their workers), with traces on, and a test stuck on a broken page is
 *      stopped sooner than the tester's own timeout allows. And for a step a
 *      test repeats (clicking "Apply" twice), a run of that test alone where
 *      only the 2nd (3rd …) answer comes late with different numbers: a test
 *      that checks the page before that answer arrives still passes.
 *   3. The verdicts (verdict.ts), with the evidence kept: a screenshot and a
 *      trace of each run where a test passed while its own call was broken.
 *
 * Nothing in the tester's project changes but the wrapper, which exists only
 * while the proof runs, and proofwright/. Playwright's output goes to a
 * folder of the proof's own, so test-results/ is left as it was.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Project, ProjectError, STATE_DIR } from "../project.js";
import {
  focusErrors,
  type PlaywrightReport,
  type PwResult,
  projectPath,
  type ReportedTest,
  reportedTests,
  runnerProblem,
  selectionArgs,
  slugOf,
  stripAnsi,
} from "../runs/runs.js";
import { type TracedCall, tracedCalls } from "./trace.js";
import { type Call, type Fault, type FaultKind, type FaultProxy, startProxy } from "./proxy.js";
import { type CellEvidence, type CleanResult, type FaultRun, judge, type ProvenTest, type StepRef, type TestCall } from "./verdict.js";
import { type Wrapper, findConfig, writeWrapper } from "./wrapper.js";

export const DEFAULT_FAULTS: FaultKind[] = ["error", "empty", "slow"];
export const DEFAULT_MAX_RUNS = 40;
export const DEFAULT_SLOW_MS = 1000;
/** A stuck test is stopped after this, at least, in a fault run. */
const MIN_FAULT_TIMEOUT_MS = 10_000;
/** Evidence kept per test, at most. */
const MAX_EVIDENCE = 3;
/** How many repeats of one step, per test, get a run of their own (the 2nd and 3rd). */
const MAX_REPEATS = 2;

/** A fault run: the fault, and — for a repeated step — the one test it's for. */
type Planned = Fault & { test?: string };

export interface ProveOptions {
  /** Test files or folders, as for Playwright's runner. */
  paths?: string[];
  project?: string;
  grep?: string;
  /** The Playwright config the tests use. Default: playwright.config.* at the root. */
  config?: string;
  /** Break only the calls whose name contains one of these ("POST /api/cart/coupon", "coupon"). */
  endpoints?: string[];
  faults?: FaultKind[];
  /** Stop before breaking anything when a proof needs more runs than this. */
  maxRuns?: number;
  /** How late every answer comes in the slow run. */
  slowMs?: number;
  /** Told of each step: "Run 3 of 14: …". */
  progress?: (message: string, done: number, total: number) => void;
}

export interface ProvedEndpoint {
  /** "POST 127.0.0.1:4610/api/cart/coupon" */
  endpoint: string;
  /** "POST /api/cart/coupon" — the host only when it isn't the app's main one. */
  name: string;
  action: boolean;
  lists: boolean;
  /** The ids of the tests that call it. */
  tests: string[];
}

export interface ProofRun {
  kind: FaultKind;
  endpoints?: string[];
  nth?: number;
  test?: string;
  label: string;
  durationMs: number;
  /** Why the run gave no results, when it didn't. */
  problem?: string;
}

export interface Proof {
  id: string;
  startedAt: string;
  durationMs: number;
  /** Project-relative. */
  config: string;
  wrapper: string;
  leftoverRemoved: boolean;
  /** The runner's selection: files, --project, --grep. */
  selection: string[];
  faults: FaultKind[];
  slowMs: number;
  clean: { tests: number; skipped: number; calls: number; durationMs: number };
  endpoints: ProvedEndpoint[];
  /** Endpoint filters that matched nothing. */
  unmatched: string[];
  runs: ProofRun[];
  /** The test timeout used in fault runs, when it was shorter than the tests' own. */
  faultTimeoutMs?: number;
  longestTestMs: number;
  https: { opened: string[]; passedThrough: string[]; untrusted: string[] };
  /**
   * Each proven test file's fingerprint (sha256 of its text), project-relative. A later
   * change is seen by what's in the file, not by its time: a file rewritten with the same
   * text (by git, a copy, another tool) is still proven.
   */
  files: Record<string, string>;
  tests: ProvenTest[];
  /** Set when the proof stopped before breaking anything. */
  stopped?: { needed: number; maxRuns: number };
  /** Project-relative: proof.json and the evidence. */
  dir: string;
}

export async function prove(project: Project, options: ProveOptions = {}): Promise<Proof> {
  for (const p of options.paths ?? []) project.resolve(p);
  const faults = options.faults && options.faults.length > 0 ? [...new Set(options.faults)] : DEFAULT_FAULTS;
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  const slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
  const progress = options.progress ?? (() => {});
  const configFile = findConfig(project, options.config);

  const startedAt = new Date().toISOString();
  const id = startedAt.replace(/[:.]/g, "-").replace(/Z$/, "");
  // Made when there's something to keep: a proof that stops at the start leaves no folder.
  const dir = path.join(project.root, STATE_DIR, "runs", "proofs", id);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-proof-"));
  const t0 = Date.now();

  let wrapper: Wrapper | undefined;
  let proxy: FaultProxy | undefined;
  let child: ChildProcess | undefined;
  const cleanUp = () => {
    child?.kill("SIGTERM");
    wrapper?.remove();
    fs.rmSync(scratch, { recursive: true, force: true });
  };
  // Stopped from outside (Ctrl-C, the client closing): the wrapper goes too.
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (signal: NodeJS.Signals) => {
    cleanUp();
    for (const s of signals) process.removeListener(s, onSignal);
    process.kill(process.pid, signal);
  };
  for (const s of signals) process.once(s, onSignal);

  try {
    wrapper = writeWrapper(configFile, path.join(scratch, "info.json"));
    const w = wrapper;
    proxy = await startProxy({ verify: () => w.info()?.ignoreHTTPSErrors !== true });
    const px = proxy;
    const env = {
      ...process.env,
      PROOFWRIGHT_PROXY: px.url,
      PROOFWRIGHT_INFO: w.infoFile,
      PROOFWRIGHT_HTTPS: px.opensHttps ? "1" : "0",
    };
    let runNo = 0;
    const runner = async (args: string[], limitMs: number) => {
      const outputDir = path.join(scratch, `run-${runNo++}`);
      const out = path.join(scratch, `report-${runNo}.json`);
      const r = await runTests(project, [
        "--config", w.file, ...args, "--reporter=json", "--output", outputDir,
      ], { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: out }, limitMs, (c) => (child = c));
      child = undefined;
      return { ...r, outputDir };
    };

    // ------------------------------------------------------------ 1. the clean run
    const selection = selectionArgs(options);
    progress("The clean run: your tests with nothing broken, one at a time", 0, 1);
    const clean = await runner([...selection, "--workers=1", "--retries=0", "--forbid-only", "--trace=on"], 60 * 60_000);
    if (w.info()?.ownProxy) {
      throw new ProjectError(`${project.relative(configFile)} sets a proxy of its own, so a proof can't put Proofwright's in front of it. Proving tests behind a proxy isn't supported yet.`);
    }
    if (!clean.report) {
      throw new ProjectError(runnerProblem(clean.full) ?? `Playwright's runner didn't finish the clean run (${clean.problem}):\n${clean.output}`);
    }
    const focused = focusErrors(project, clean.report);
    if (focused.length > 0) {
      throw new ProjectError(
        `Playwright stopped: ${focused.map((f) => `\`test.only\` at ${f}`).join(", ")} would narrow the proof to ${focused.length === 1 ? "that test" : "those tests"}. Remove the \`.only\`, or name the files to prove.`,
      );
    }
    const reported = reportedTests(project, clean.report).filter((t) => !isSkipped(t));
    const skipped = reportedTests(project, clean.report).length - reported.length;
    if (reported.length === 0) {
      const errors = (clean.report.errors ?? []).map((e) => stripAnsi(e.message ?? ""));
      const known = runnerProblem([...errors, clean.full].join("\n"));
      if (known) throw new ProjectError(known);
      const why = errors.map((e) => e.split("\n")[0]).find(Boolean);
      throw new ProjectError(`No tests ran${why ? `: ${why}` : ""}. Check the files, project or grep you named.`);
    }

    const cleanCalls = [...px.calls];
    const byTest = attribute(reported, cleanCalls);
    // Which step made each call, from each test's trace (when it can be read).
    const traced = new Map<string, TracedCall[]>();
    const isTestFile = (abs: string) => {
      const rel = project.relative(abs);
      return !rel.startsWith("..") && !rel.split("/").includes("node_modules");
    };
    for (const t of reported) {
      const trace = [...t.test.results].reverse().flatMap((r) => r.attachments ?? []).find((a) => a.name === "trace")?.path;
      if (!trace || !fs.existsSync(trace)) continue;
      try {
        traced.set(t.id, tracedCalls(trace, isTestFile));
      } catch {
        // an unreadable trace: the calls are named instead
      }
    }
    const stepOf = (testId: string, endpoint: string, nth: number): StepRef | undefined => {
      const step = (traced.get(testId) ?? []).filter((c) => c.endpoint === endpoint)[nth - 1]?.step;
      return step ? { name: step.name, at: `${project.relative(step.file)}:${step.line}` } : undefined;
    };
    const api = cleanCalls.filter((c) => c.action || c.json);
    const mainHost = mostCommon(api.map((c) => c.host));
    const name = (endpoint: string) => {
      const [method, rest] = [endpoint.slice(0, endpoint.indexOf(" ")), endpoint.slice(endpoint.indexOf(" ") + 1)];
      return mainHost && rest.startsWith(`${mainHost}/`) ? `${method} ${rest.slice(mainHost.length)}` : endpoint;
    };

    const endpointMap = new Map<string, ProvedEndpoint>();
    const callsOf = new Map<string, TestCall[]>();
    for (const t of reported) {
      const mine = new Map<string, TestCall>();
      for (const c of byTest.get(t.id) ?? []) {
        if (!(c.action || c.json)) continue;
        mine.set(c.endpoint, { endpoint: c.endpoint, action: c.action });
        const e = endpointMap.get(c.endpoint) ?? { endpoint: c.endpoint, name: name(c.endpoint), action: c.action, lists: false, tests: [] };
        e.lists ||= c.lists;
        if (!e.tests.includes(t.id)) e.tests.push(t.id);
        endpointMap.set(c.endpoint, e);
      }
      callsOf.set(t.id, [...mine.values()]);
    }
    const filters = (options.endpoints ?? []).map((f) => f.trim()).filter(Boolean);
    const matches = (e: ProvedEndpoint, f: string) => e.name.toLowerCase().includes(f.toLowerCase()) || e.endpoint.toLowerCase().includes(f.toLowerCase());
    const endpoints = [...endpointMap.values()]
      .filter((e) => filters.length === 0 || filters.some((f) => matches(e, f)))
      .sort((a, b) => Number(b.action) - Number(a.action) || a.name.localeCompare(b.name));
    const unmatched = filters.filter((f) => ![...endpointMap.values()].some((e) => matches(e, f)));

    // ------------------------------------------------------------ 2. the plan
    const plan: Planned[] = [];
    for (const e of endpoints) {
      if (faults.includes("error")) plan.push({ kind: "error", endpoints: [e.endpoint] });
      if (!e.action && e.lists && faults.includes("empty")) plan.push({ kind: "empty", endpoints: [e.endpoint] });
      if (!e.action && faults.includes("malformed")) plan.push({ kind: "malformed", endpoints: [e.endpoint] });
    }
    // A step a test repeats: the 2nd (3rd) answer late and changed, in a run of that test alone.
    const chosen = new Set(endpoints.map((e) => e.endpoint));
    for (const t of reported) {
      const repeats = new Map<string, number>();
      for (const c of byTest.get(t.id) ?? []) {
        if (c.action && chosen.has(c.endpoint)) repeats.set(c.endpoint, (repeats.get(c.endpoint) ?? 0) + 1);
      }
      for (const [endpoint, n] of repeats) {
        for (let nth = 2; nth <= Math.min(n, 1 + MAX_REPEATS); nth++) {
          plan.push({ kind: "changed", endpoints: [endpoint], nth, delayMs: slowMs, test: t.id });
        }
      }
    }
    if (faults.includes("slow") && endpoints.length > 0) {
      plan.push({ kind: "slow", delayMs: slowMs, ...(filters.length > 0 ? { endpoints: endpoints.map((e) => e.endpoint) } : {}) });
    }

    const attemptsMs = reported.flatMap((t) => t.test.results.map((r) => r.duration));
    const longestTestMs = Math.max(0, ...attemptsMs);
    const faultTimeoutMs = faultTimeoutFor(longestTestMs, Math.min(...reported.map((t) => t.test.timeout ?? Number.POSITIVE_INFINITY)));
    const cleanMs = Math.round(clean.report.stats?.duration ?? 0);

    const proof: Proof = {
      id,
      startedAt,
      durationMs: 0,
      config: project.relative(configFile),
      wrapper: project.relative(w.file),
      leftoverRemoved: w.leftover,
      selection,
      faults,
      slowMs,
      clean: { tests: reported.length, skipped, calls: api.length, durationMs: cleanMs },
      endpoints,
      unmatched,
      runs: [],
      ...(faultTimeoutMs ? { faultTimeoutMs } : {}),
      longestTestMs,
      https: { opened: [], passedThrough: [], untrusted: [] },
      files: fingerprints(project, reported.map((t) => t.file)),
      tests: [],
      dir: project.relative(dir),
    };

    const cleanResults: CleanResult[] = reported.map((t) => {
      const failed = lastWith(t.test.results, (r) => r.status === "failed" || r.status === "timedOut");
      return {
        id: t.id,
        title: t.title,
        file: t.file,
        line: t.spec.line,
        status: t.test.status === "flaky" ? "flaky" : t.test.status === "unexpected" ? "failed" : "passed",
        attempts: t.test.results.map((r) => r.status),
        expectedToFail: t.test.expectedStatus === "failed",
        ...(failed?.error?.message ? { error: firstLine(failed.error.message) } : {}),
        calls: callsOf.get(t.id) ?? [],
      };
    });

    const faultRuns: FaultRun[] = [];
    if (plan.length > maxRuns) {
      proof.stopped = { needed: plan.length, maxRuns };
    } else {
      // ---------------------------------------------------------- 3. the fault runs
      const filesOf = new Map(reported.map((t) => [t.id, t.file]));
      const allFiles = [...new Set(reported.map((t) => t.file))];
      const limitMs = Math.max(10 * 60_000, 5 * cleanMs);
      const kept = new Map<string, number>();
      const lineOf = new Map(reported.map((t) => [t.id, t.spec.line]));
      const cleanPassed = new Set(cleanResults.filter((c) => c.status === "passed" && !c.expectedToFail).map((c) => c.id));
      const titleOf = new Map(reported.map((t) => [t.id, t.title]));
      for (const [i, fault] of plan.entries()) {
        const label = faultLabel(fault, name, slowMs, stepOf, titleOf);
        progress(`Run ${i + 1} of ${plan.length}: ${label}`, i + 1, plan.length + 1);
        const calledBy = fault.test
          ? [fault.test]
          : fault.endpoints
            ? endpoints.filter((e) => fault.endpoints!.includes(e.endpoint)).flatMap((e) => e.tests)
            : reported.map((t) => t.id);
        const files = fault.endpoints ? [...new Set(calledBy.map((tid) => filesOf.get(tid)!))] : allFiles;
        const { test: only, ...proxyFault } = fault;
        px.fault = proxyFault;
        const before = px.calls.length;
        const started = Date.now();
        const r = await runner(
          [
            ...(only ? [`${fileFilter(filesOf.get(only)!)}:${lineOf.get(only)}`] : files.map(fileFilter)),
            ...(options.project ? ["--project", options.project] : []),
            ...(options.grep ? ["--grep", options.grep] : []),
            "--retries=0",
            "--trace=on",
            ...(faultTimeoutMs && fault.kind !== "slow" ? [`--timeout=${faultTimeoutMs}`] : []),
          ],
          limitMs,
        );
        px.fault = undefined;
        const applied = px.calls.slice(before).some((c) => c.broken !== undefined);
        proof.runs.push({
          kind: fault.kind,
          ...(fault.endpoints ? { endpoints: fault.endpoints } : {}),
          ...(fault.nth ? { nth: fault.nth } : {}),
          ...(only ? { test: only } : {}),
          label,
          durationMs: Date.now() - started,
          ...(r.report ? {} : { problem: r.problem }),
        });
        const results: FaultRun["results"] = {};
        for (const t of r.report ? reportedTests(project, r.report) : []) {
          if (!filesOf.has(t.id)) continue;
          const failed = lastWith(t.test.results, (x) => x.status === "failed" || x.status === "timedOut");
          const passed = lastWith(t.test.results, (x) => x.status === "passed");
          const attempts = t.test.results.map((x) => x.status);
          const own = calledBy.includes(t.id);
          // Evidence of what decides a verdict: a test passing while its own step was
          // broken (an action's call failing, or a repeat's answers late and different —
          // or any call, for a test that makes no actions), or failing when answers were
          // only late. A background read it didn't need isn't worth a screenshot.
          const decides =
            fault.kind === "changed" ||
            (fault.kind === "error" && fault.endpoints!.some((e) => endpointMap.get(e)?.action)) ||
            !(callsOf.get(t.id) ?? []).some((c) => c.action);
          // …and only from a run that broke something, for a test that passed with nothing broken.
          const worth = applied && cleanPassed.has(t.id) && ((own && fault.kind !== "slow" && passed && decides) || (fault.kind === "slow" && failed && !passed));
          const n = kept.get(t.id) ?? 0;
          let evidence: CellEvidence | undefined;
          if (worth && n < MAX_EVIDENCE) {
            evidence = keep(project, path.join(dir, `${slugOf(t.title)}-${shortId(t.id)}`, faultSlug(fault, name)), (passed ?? failed)!);
            kept.set(t.id, n + 1);
          }
          results[t.id] = {
            attempts,
            ...(failed?.error?.message ? { error: firstLine(failed.error.message) } : {}),
            ...(failed?.error?.location ? { errorAt: `${projectPath(project, failed.error.location.file)}:${failed.error.location.line}` } : {}),
            ...(evidence ? { evidence } : {}),
          };
        }
        faultRuns.push({
          kind: fault.kind,
          ...(fault.endpoints ? { endpoints: fault.endpoints } : {}),
          ...(fault.nth ? { nth: fault.nth } : {}),
          ...(only ? { test: only } : {}),
          applied,
          results,
        });
        fs.rmSync(r.outputDir, { recursive: true, force: true });
      }
    }

    proof.tests = judge(cleanResults, faultRuns, { name, step: stepOf, limited: filters.length > 0 });
    proof.https = {
      opened: [...new Set(px.calls.filter((c) => c.https).map((c) => c.host))].sort(),
      passedThrough: [...px.passedThrough].sort(),
      untrusted: [...px.untrusted].sort(),
    };
    proof.durationMs = Date.now() - t0;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
    return proof;
  } finally {
    for (const s of signals) process.removeListener(s, onSignal);
    cleanUp();
    await proxy?.close();
  }
}

// ---------------------------------------------------------------- helpers

/** A file's fingerprint: the sha256 of its text. */
export function fingerprint(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** The fingerprints of the test files a proof ran, by project-relative path. */
function fingerprints(project: Project, files: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of [...new Set(files)].sort()) {
    try {
      out[f] = fingerprint(path.join(project.root, f));
    } catch {
      // gone since the clean run: nothing to compare with later
    }
  }
  return out;
}

/**
 * The test timeout for fault runs: 3× the slowest clean test, at least 10 s —
 * or none (the tests' own) when that isn't shorter. A fault answers at once, so
 * a test that hasn't noticed by then is stuck on a broken page; a longer limit
 * than the tests' own would let a test pass that normally fails.
 */
export function faultTimeoutFor(longestTestMs: number, ownTimeoutMs: number): number | undefined {
  const t = Math.max(MIN_FAULT_TIMEOUT_MS, 3 * longestTestMs);
  return t < ownTimeoutMs ? t : undefined;
}

interface RunnerResult {
  report?: PlaywrightReport;
  /** The last lines the runner printed, for when it went wrong. */
  output: string;
  /** More of what it printed, to recognise a known problem in. */
  full: string;
  problem?: string;
}

function runTests(
  project: Project,
  args: string[],
  env: NodeJS.ProcessEnv,
  limitMs: number,
  started: (child: ChildProcess) => void,
): Promise<RunnerResult> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["--no-install", "playwright", "test", ...args], { cwd: project.root, env, stdio: ["ignore", "pipe", "pipe"] });
    started(child);
    let output = "";
    const keepTail = (d: Buffer) => {
      output = (output + d.toString("utf8")).slice(-16_000);
    };
    child.stdout.on("data", keepTail);
    child.stderr.on("data", keepTail);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, limitMs);
    const finish = (code: number | null, error?: Error) => {
      clearTimeout(timer);
      const file = env.PLAYWRIGHT_JSON_OUTPUT_FILE!;
      let report: PlaywrightReport | undefined;
      try {
        report = JSON.parse(fs.readFileSync(file, "utf8")) as PlaywrightReport;
      } catch {
        report = undefined;
      }
      const tail = stripAnsi(output).trim().split("\n").slice(-8).join("\n");
      resolve({
        ...(report && !timedOut ? { report } : {}),
        output: tail,
        full: stripAnsi(output),
        ...(timedOut
          ? { problem: `stopped after ${Math.round(limitMs / 60_000)} min` }
          : report
            ? {}
            : { problem: error ? error.message : `exit ${code}` }),
      });
    };
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code));
  });
}

function isSkipped(t: ReportedTest): boolean {
  return t.test.expectedStatus === "skipped" || t.test.results.every((r) => r.status === "skipped");
}

/** Each call to the test that made it: the last one to start before it (the clean run has one worker). */
function attribute(tests: ReportedTest[], calls: Call[]): Map<string, Call[]> {
  const starts = tests
    .flatMap((t) => t.test.results.filter((r) => r.startTime).map((r) => ({ id: t.id, at: Date.parse(r.startTime!) })))
    .sort((a, b) => a.at - b.at);
  const out = new Map<string, Call[]>();
  for (const c of calls) {
    let owner: string | undefined;
    for (const s of starts) {
      if (s.at > c.at) break;
      owner = s.id;
    }
    if (!owner) continue;
    out.set(owner, [...(out.get(owner) ?? []), c]);
  }
  return out;
}

function lastWith(results: PwResult[], pick: (r: PwResult) => boolean): PwResult | undefined {
  return [...results].reverse().find(pick);
}

function firstLine(message: string): string {
  return stripAnsi(message).split("\n").find((l) => l.trim())?.trim().replace(/^Error: /, "") ?? "";
}

function mostCommon(values: string[]): string | undefined {
  const n = new Map<string, number>();
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** A runner filter that matches this one file, and no other. */
function fileFilter(file: string): string {
  return `(^|/)${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

function faultLabel(
  fault: Planned,
  name: (e: string) => string,
  slowMs: number,
  stepOf: (testId: string, endpoint: string, nth: number) => StepRef | undefined,
  titleOf: Map<string, string>,
): string {
  if (fault.kind === "slow") return `every answer ${slowMs >= 1000 ? `${slowMs / 1000} s` : `${slowMs} ms`} late`;
  const e = name(fault.endpoints![0]);
  if (fault.kind === "changed" && fault.test) {
    const step = stepOf(fault.test, fault.endpoints![0], fault.nth ?? 2);
    const what = step ? (/^click (".*")$/.exec(step.name)?.[1] ?? step.name) : e;
    return `"${titleOf.get(fault.test)}": the answers to the ${fault.nth === 3 ? "3rd" : `${fault.nth}nd`} ${what} come late and different`;
  }
  return fault.kind === "error" ? `${e} fails with a server error` : fault.kind === "empty" ? `${e} answers with empty lists` : `${e} answers with broken data`;
}

function faultSlug(fault: Planned, name: (e: string) => string): string {
  if (fault.kind === "slow") return "slow";
  return `${fault.kind}${fault.nth ? `-${fault.nth}` : ""}-${slugOf(name(fault.endpoints![0]))}`;
}

function shortId(testId: string): string {
  return (testId.split("-").pop() ?? "").slice(0, 8);
}

/** Copy a run's screenshot and trace for one test into the proof's folder. */
function keep(project: Project, into: string, result: PwResult): CellEvidence {
  const evidence: CellEvidence = {};
  const copy = (attachment: string, key: keyof CellEvidence, fileName: string) => {
    const a = (result.attachments ?? []).find((x) => x.name === attachment);
    if (!a?.path || !fs.existsSync(a.path)) return;
    fs.mkdirSync(into, { recursive: true });
    fs.copyFileSync(a.path, path.join(into, fileName));
    evidence[key] = project.relative(path.join(into, fileName));
  };
  copy("screenshot", "screenshot", "screenshot.png");
  copy("trace", "trace", "trace.zip");
  return evidence;
}

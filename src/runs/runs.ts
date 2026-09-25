/**
 * Runs: what Playwright's runner reported, kept with its evidence.
 *
 * Proofwright doesn't run tests itself. It asks Playwright's own runner —
 * `npx playwright test`, with the project's config — for its JSON report, or
 * reads a JSON report the tester already has (from CI, say). Each run is kept
 * in proofwright/runs/<id>/ with the evidence of every failure copied beside
 * it (screenshot, the page as it was, the trace), because Playwright clears
 * test-results/ on its next run and the links would go dead.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Project, ProjectError } from "../project.js";

export type TestStatus = "passed" | "failed" | "flaky" | "skipped";

export interface Evidence {
  /** Project-relative paths, inside the run's folder. */
  screenshot?: string;
  errorContext?: string;
  trace?: string;
}

export interface RunTest {
  /** Playwright's id for the test in its project — stable across runs. */
  id: string;
  /** "describe › title". */
  title: string;
  file: string;
  line: number;
  project: string;
  status: TestStatus;
  /** Each attempt's outcome, in order. */
  attempts: string[];
  durationMs: number;
  error?: { message: string; file?: string; line?: number };
  evidence: Evidence;
  /** The test case it tests, when its title starts with one (TC-001 …). */
  caseId?: string;
}

export interface Run {
  id: string;
  startedAt: string;
  durationMs: number;
  /** How the results came: Playwright was run, or a JSON report was read. */
  source: { ran: string[] } | { imported: string };
  git?: { head: string; dirty: boolean };
  /** Errors Playwright reported for the run as a whole ("No tests found" …). */
  errors: string[];
  /**
   * Tests marked `.only` (file:line). When there are any, Playwright ran only
   * those, and the rest of the selection didn't run at all.
   */
  focused?: string[];
  tests: RunTest[];
}

export interface RunOptions {
  paths?: string[];
  project?: string;
  grep?: string;
  timeoutMinutes?: number;
}

const RUNS = "runs";
const MAX_TRACE_BYTES = 20 * 1024 * 1024;
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** The runner's arguments that choose which tests run. */
export function selectionArgs(opts: Pick<RunOptions, "paths" | "project" | "grep">): string[] {
  return [...(opts.paths ?? []), ...(opts.project ? ["--project", opts.project] : []), ...(opts.grep ? ["--grep", opts.grep] : [])];
}

/** Run Playwright's runner with its JSON reporter and record the run. */
export function runPlaywright(project: Project, opts: RunOptions = {}): Run {
  for (const p of opts.paths ?? []) project.resolve(p);
  const focused = focusedTests(project, opts);
  const args = ["--no-install", "playwright", "test", ...selectionArgs(opts), "--reporter=json", "--trace=retain-on-failure"];
  const { report, child } = spawnForReport(project, args, (opts.timeoutMinutes ?? 15) * 60_000);
  if (!report) {
    const why = child.error?.message ?? stripAnsi(`${child.stderr ?? ""}${child.stdout ?? ""}`).trim().split("\n").slice(-6).join("\n");
    throw new ProjectError(`Playwright's runner didn't produce a report (${child.status === null ? "it was stopped" : `exit ${child.status}`}):\n${why}`);
  }
  return record(project, report, { ran: ["npx", "playwright", "test", ...args.slice(3)] }, focused);
}

/**
 * The tests marked `.only` in the selection, as file:line. Playwright runs only
 * those when there are any — and says nothing about the rest — so this asks it
 * to list the selection with `--forbid-only`, which names every one of them.
 */
export function focusedTests(project: Project, opts: Pick<RunOptions, "paths" | "project" | "grep"> = {}): string[] {
  const { report } = spawnForReport(project, ["--no-install", "playwright", "test", ...selectionArgs(opts), "--list", "--forbid-only", "--reporter=json"], 120_000);
  return report ? focusErrors(project, report) : [];
}

/** The `.only` locations in a report Playwright wrote with --forbid-only. */
export function focusErrors(project: Project, report: PlaywrightReport): string[] {
  return (report.errors ?? [])
    .filter((e) => /item focused with '\.only'/.test(e.message ?? ""))
    .map((e) => (e.location ? `${projectPath(project, e.location.file)}:${e.location.line}` : stripAnsi(e.message ?? "")));
}

function spawnForReport(project: Project, args: string[], timeoutMs: number) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-run-")), "report.json");
  const child = spawnSync("npx", args, {
    cwd: project.root,
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: out },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const report = fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, "utf8")) as PlaywrightReport) : undefined;
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  return { report, child };
}

/** Read a JSON report Playwright already wrote, and record it. */
export function importReport(project: Project, file: string): Run {
  const abs = project.resolve(file);
  if (!fs.existsSync(abs)) throw new ProjectError(`There's no report at ${file}.`);
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    throw new ProjectError(`${file} isn't a JSON report.`);
  }
  if (!json || typeof json !== "object" || !("suites" in json)) {
    throw new ProjectError(`${file} isn't a Playwright JSON report (use --reporter=json).`);
  }
  return record(project, json as PlaywrightReport, { imported: project.relative(abs) });
}

// ---------------------------------------------------------------- Playwright's JSON report

export interface PwAttachment {
  name: string;
  contentType?: string;
  path?: string;
}
export interface PwResult {
  status: string;
  retry: number;
  duration: number;
  startTime?: string;
  error?: { message?: string; location?: { file: string; line: number } };
  attachments?: PwAttachment[];
}
export interface PwTest {
  projectName: string;
  status: string;
  expectedStatus?: string;
  timeout?: number;
  results: PwResult[];
}
export interface PwSpec {
  id: string;
  title: string;
  file: string;
  line: number;
  tests: PwTest[];
}
interface PwSuite {
  title: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
export interface PlaywrightReport {
  config?: { rootDir?: string };
  suites: PwSuite[];
  errors?: Array<{ message?: string; location?: { file: string; line: number } }>;
  stats?: { startTime?: string; duration?: number };
}

/** One test in one Playwright project, as the report has it. */
export interface ReportedTest {
  /** Playwright's id for the test in its project — stable across runs. */
  id: string;
  /** "describe › title". */
  title: string;
  /** Project-relative. */
  file: string;
  spec: PwSpec;
  test: PwTest;
}

/** Every test in a Playwright JSON report, in the report's order. */
export function reportedTests(project: Project, report: PlaywrightReport): ReportedTest[] {
  const out: ReportedTest[] = [];
  const walk = (suite: PwSuite, trail: string[]) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        out.push({
          id: `${test.projectName}:${spec.id}`,
          title: [...trail, spec.title].join(" › "),
          file: projectPath(project, spec.file, report.config?.rootDir),
          spec,
          test,
        });
      }
    }
    // Top-level suites are files; the ones inside are describe blocks, part of the title.
    for (const s of suite.suites ?? []) walk(s, [...trail, s.title]);
  };
  for (const s of report.suites) walk(s, []);
  return out;
}

export const STATUS: Record<string, TestStatus> = { expected: "passed", unexpected: "failed", flaky: "flaky", skipped: "skipped" };

function record(project: Project, report: PlaywrightReport, source: Run["source"], focused: string[] = []): Run {
  const startedAt = report.stats?.startTime ?? new Date().toISOString();
  const id = startedAt.replace(/[:.]/g, "-").replace(/Z$/, "");
  const dir = project.stateFile(RUNS, id, "run.json");
  const runDir = path.dirname(dir);
  const testDir = report.config?.rootDir;
  const tests: RunTest[] = [];

  for (const { id: testId, title, file, spec, test: t } of reportedTests(project, report)) {
    const failed = [...t.results].reverse().find((r) => r.status !== "passed" && r.status !== "skipped");
    const status = STATUS[t.status] ?? "failed";
    const test: RunTest = {
      id: testId,
      title,
      file,
      line: spec.line,
      project: t.projectName,
      status,
      attempts: t.results.map((r) => r.status),
      durationMs: t.results.reduce((n, r) => n + r.duration, 0),
      evidence: {},
      ...(/^(TC-\d{3,})\b/.test(spec.title) ? { caseId: /^(TC-\d{3,})/.exec(spec.title)![1] } : {}),
    };
    if (failed?.error?.message) {
      const loc = failed.error.location;
      test.error = {
        message: stripAnsi(failed.error.message),
        ...(loc ? { file: projectPath(project, loc.file, testDir), line: loc.line } : {}),
      };
    }
    if (failed && status !== "passed") test.evidence = keepEvidence(project, runDir, test, failed.attachments ?? []);
    tests.push(test);
  }

  const run: Run = {
    id,
    startedAt,
    durationMs: Math.round(report.stats?.duration ?? 0),
    source,
    ...gitState(project),
    errors: (report.errors ?? []).map((e) => stripAnsi(e.message ?? "").split("\n")[0]).filter(Boolean),
    ...(focused.length > 0 ? { focused } : {}),
    tests,
  };
  fs.writeFileSync(dir, `${JSON.stringify(run, null, 2)}\n`);
  return run;
}

export function projectPath(project: Project, file: string, testDir?: string): string {
  const abs = path.isAbsolute(file) ? file : path.resolve(testDir ?? project.root, file);
  const rel = project.relative(abs);
  return rel.startsWith("..") ? file : rel;
}

/** "Coupon works — SAVE10" → "coupon-works-save10": a folder name for a test's evidence. */
export function slugOf(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "test";
}

function keepEvidence(project: Project, runDir: string, test: RunTest, attachments: PwAttachment[]): Evidence {
  const slug = slugOf(test.title);
  const into = path.join(runDir, `${slug}-${(test.id.split("-").pop() ?? "").slice(0, 8)}`);
  const evidence: Evidence = {};
  const copy = (a: PwAttachment | undefined, key: keyof Evidence, name: string) => {
    if (!a?.path || !fs.existsSync(a.path)) return;
    if (key === "trace" && fs.statSync(a.path).size > MAX_TRACE_BYTES) return;
    fs.mkdirSync(into, { recursive: true });
    const dest = path.join(into, name);
    fs.copyFileSync(a.path, dest);
    evidence[key] = project.relative(dest);
  };
  copy(attachments.find((a) => a.name === "screenshot"), "screenshot", "screenshot.png");
  copy(attachments.find((a) => a.name === "error-context"), "errorContext", "error-context.md");
  copy(attachments.find((a) => a.name === "trace"), "trace", "trace.zip");
  return evidence;
}

function gitState(project: Project): { git?: Run["git"] } {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: project.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .some((l) => l.trim() && !l.includes("proofwright/runs/"));
    return { git: { head, dirty } };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- history

export function listRuns(project: Project): string[] {
  const dir = path.join(project.root, "proofwright", RUNS);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, "run.json")))
    .sort();
}

export function loadRun(project: Project, id: string): Run {
  const file = path.join(project.root, "proofwright", RUNS, id, "run.json");
  if (!fs.existsSync(file)) throw new ProjectError(`There's no recorded run ${id}.`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as Run;
}

export function latestRun(project: Project): Run {
  const ids = listRuns(project);
  if (ids.length === 0) throw new ProjectError("There's no recorded run yet. Ask for a report with a run first.");
  return loadRun(project, ids[ids.length - 1]);
}

/** The run recorded just before `id`, if any. */
export function previousRun(project: Project, id: string): Run | undefined {
  const ids = listRuns(project).filter((x) => x < id);
  return ids.length > 0 ? loadRun(project, ids[ids.length - 1]) : undefined;
}

/** This test's status in the recorded runs up to `id`, oldest first (at most `limit`). */
export function historyOf(project: Project, testId: string, id: string, limit = 5): Array<{ run: string; status: TestStatus; head?: string }> {
  const out: Array<{ run: string; status: TestStatus; head?: string }> = [];
  for (const rid of listRuns(project).filter((x) => x <= id)) {
    const run = loadRun(project, rid);
    const t = run.tests.find((x) => x.id === testId);
    if (t) out.push({ run: rid, status: t.status, head: run.git?.head });
  }
  return out.slice(-limit);
}

export interface Comparison {
  newFailures: RunTest[];
  stillFailing: RunTest[];
  fixed: RunTest[];
  newTests: RunTest[];
}

/** What changed since the previous run, over the tests both runs ran. */
export function compare(prev: Run | undefined, cur: Run): Comparison {
  const before = new Map((prev?.tests ?? []).map((t) => [t.id, t]));
  const bad = (s: TestStatus) => s === "failed";
  const out: Comparison = { newFailures: [], stillFailing: [], fixed: [], newTests: [] };
  for (const t of cur.tests) {
    const b = before.get(t.id);
    if (!b) {
      if (prev) out.newTests.push(t);
      continue;
    }
    if (bad(t.status) && !bad(b.status)) out.newFailures.push(t);
    else if (bad(t.status) && bad(b.status)) out.stillFailing.push(t);
    else if (!bad(t.status) && t.status !== "skipped" && bad(b.status)) out.fixed.push(t);
  }
  return out;
}

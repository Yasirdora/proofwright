/**
 * The `report` and `explain` tools, on top of Playwright's runner.
 *
 * report  — run Playwright (or read its JSON report), keep the run and its
 *           evidence, compare with the run before, and give the one-page
 *           summary: what's new, what's fixed, and a one-line diagnosis per
 *           failure. It writes the page to proofwright/reports/.
 * explain — one failure in depth: what happened, the evidence, the reasoning,
 *           how sure, and what to do — with a bug report drafted for an app
 *           bug. It proposes; it never changes a test.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Answer, count } from "../answer.js";
import { type Project, ProjectError } from "../project.js";
import { classify, type Diagnosis } from "./classify.js";
import {
  compare,
  historyOf,
  importReport,
  latestRun,
  loadRun,
  previousRun,
  type Run,
  type RunOptions,
  runPlaywright,
  type RunTest,
} from "./runs.js";

export interface ReportInput {
  /** Run Playwright's runner now (with these options), instead of reporting the last run. */
  run?: RunOptions | boolean;
  /** Read a Playwright JSON report (e.g. from CI) instead of running. */
  from?: string;
}

export interface ReportData {
  run: Run;
  previous?: string;
  diagnoses: Array<{ test: string; title: string; diagnosis: Diagnosis }>;
  reportFile: string;
}

export function report(project: Project, input: ReportInput = {}): Answer<ReportData> {
  if (input.run && input.from) throw new ProjectError("Either run the tests or read a report — not both.");
  const did: string[] = [];
  let run: Run;
  if (input.from) {
    run = importReport(project, input.from);
    did.push(`Read Playwright's JSON report \`${input.from}\` and kept it as run ${run.id}.`);
  } else if (input.run) {
    run = runPlaywright(project, input.run === true ? {} : input.run);
    did.push(`Ran \`${(run.source as { ran: string[] }).ran.join(" ")}\` with your config, and kept every failure's screenshot and trace (run ${run.id}).`);
  } else {
    run = latestRun(project);
    did.push(`Reported on the last recorded run, ${run.id} (nothing was run now).`);
  }
  const prev = previousRun(project, run.id);
  const changes = compare(prev, run);
  if (prev) did.push(`Compared it with the run before (${prev.id}).`);

  const failures = run.tests.filter((t) => t.status === "failed" || t.status === "flaky");
  const diagnoses = failures.map((t) => ({ test: t.id, title: t.title, diagnosis: diagnose(project, run, t) }));
  const tally = (s: RunTest["status"]) => run.tests.filter((t) => t.status === s).length;
  const headline =
    run.tests.length === 0
      ? `No tests ran${run.errors.length > 0 ? `: ${run.errors[0]}` : "."}`
      : `${count(run.tests.length, "test")}: ${tally("passed")} passed, ${tally("failed")} failed, ${tally("flaky")} flaky` +
        (tally("skipped") > 0 ? `, ${tally("skipped")} skipped` : "") +
        (prev ? ` — ${count(changes.newFailures.length, "new failure")}, ${changes.fixed.length} fixed since the last run.` : ".") +
        (run.focused ? " Only the tests marked test.only ran." : "");

  const found = renderReport(run, prev, changes, diagnoses);
  const reportFile = project.stateFile("reports", `${run.id}.md`);
  fs.writeFileSync(reportFile, `# Test report — run ${run.id}\n\n**${headline}**\n\n${found}\n`);
  did.push(`Saved this report as \`${project.relative(reportFile)}\`.`);

  return {
    headline,
    did,
    found,
    need: [
      ...(run.focused
        ? [`Remove the \`.only\` at ${run.focused.map((f) => `\`${f}\``).join(", ")} and run again — or tell me you meant to run only ${run.focused.length === 1 ? "that test" : "those tests"}.`]
        : []),
      ...diagnoses.map(({ title, diagnosis }) => `"${title}": ${TODO[diagnosis.kind]}`),
      ...(diagnoses.length > 0 ? [`For the full reasons, ask me to explain a failure — for example "explain ${diagnoses[0].title}".`] : []),
    ],
    next: diagnoses.length === 0 ? "Nothing failed." : undefined,
    data: { run, ...(prev ? { previous: prev.id } : {}), diagnoses, reportFile: project.relative(reportFile) },
  };
}

export interface ExplainInput {
  /** Which failure: part of its title, its test case number (TC-003), or file:line. */
  test: string;
  /** Which run (default: the last one). */
  run?: string;
}

export interface ExplainData {
  run: string;
  test: RunTest;
  diagnosis: Diagnosis;
  bugDraft?: string;
}

export function explain(project: Project, input: ExplainInput): Answer<ExplainData> {
  const run = input.run ? loadRun(project, input.run) : latestRun(project);
  const test = findFailure(run, input.test);
  const diagnosis = diagnose(project, run, test);
  const snapshot = snapshotOf(project, test);
  const source = sourceLines(project, test);
  const history = historyOf(project, test.id, run.id);
  const bugDraft = diagnosis.kind === "app bug" ? draftBug(project, test, diagnosis, source) : undefined;

  const evidence = [
    ...(test.evidence.screenshot ? [`- Screenshot: [${test.evidence.screenshot}](${test.evidence.screenshot})`] : []),
    ...(test.evidence.trace ? [`- Trace: \`npx playwright show-trace ${test.evidence.trace}\` — every step, the network, the console`] : []),
    ...(test.evidence.errorContext ? [`- The page as it was, and Playwright's own error details: [${test.evidence.errorContext}](${test.evidence.errorContext})`] : []),
  ];
  const found = [
    `**What happened** — ${test.error?.line ? `[${test.error.file}:${test.error.line}](${test.error.file}:${test.error.line})` : test.file}`,
    ...(source.failingLine ? ["```ts", source.failingLine, "```"] : []),
    ...(diagnosis.expected !== undefined ? [`Expected: ${diagnosis.expected} · Received: ${diagnosis.received}`] : []),
    "",
    `**Why I think it's ${article(diagnosis.kind)} (${diagnosis.confidence})**`,
    ...diagnosis.reasoning.map((r) => `- ${r}`),
    "",
    "**Evidence**",
    ...(evidence.length > 0 ? evidence : ["- Playwright kept no screenshot or trace for this run."]),
    ...(snapshot ? ["", "The page when it failed (excerpt):", "```yaml", snapshot, "```"] : []),
    "",
    `**History** — ${history.map((h) => h.status).join(" → ")} (oldest first, this run last)`,
    "",
    `**What I'd do** — ${diagnosis.proposal}`,
    ...(bugDraft ? ["", "**Bug report, drafted** (edit before filing):", "", bugDraft] : []),
  ].join("\n");

  const need: Record<Diagnosis["kind"], string> = {
    "app bug": "File the bug (the draft is above), or tell me the requirement changed — then the test case changes first.",
    "test bug": "Tell me whether the proposed fix is right; I'll change the test only on your yes.",
    flaky: "Tell me whether to look for the timing problem in the test or in the app.",
    environment: "Check that the service is up and reachable, then ask for a report with a run again.",
    unclear: "Look at the screenshot or trace and tell me what you see.",
  };
  return {
    headline: `${cap(diagnosis.kind)} (${diagnosis.confidence}): ${diagnosis.summary}.`,
    did: [
      `Read what Playwright kept for "${test.title}" in run ${run.id}: the error${test.evidence.errorContext ? ", the page at the moment it failed" : ""}${test.evidence.screenshot ? ", the screenshot" : ""}${test.evidence.trace ? ", the trace" : ""}.`,
      "Nothing was changed.",
    ],
    found,
    need: [need[diagnosis.kind]],
    data: { run: run.id, test, diagnosis, ...(bugDraft ? { bugDraft } : {}) },
  };
}

// ---------------------------------------------------------------- helpers

function diagnose(project: Project, run: Run, test: RunTest): Diagnosis {
  const history = historyOf(project, test.id, run.id).slice(0, -1);
  return classify(test, {
    snapshot: fullSnapshot(project, test),
    history,
    ...(run.git?.head ? { head: run.git.head } : {}),
    approvedCase: test.caseId !== undefined && caseApproved(project, test.caseId),
  });
}

function findFailure(run: Run, query: string): RunTest {
  const q = query.trim().toLowerCase();
  const failures = run.tests.filter((t) => t.status === "failed" || t.status === "flaky");
  const byLine = /^(.+):(\d+)$/.exec(query.trim());
  const hits = failures.filter(
    (t) =>
      t.caseId?.toLowerCase() === q ||
      t.title.toLowerCase().includes(q) ||
      (byLine && t.file === byLine[1] && (t.line === Number(byLine[2]) || t.error?.line === Number(byLine[2]))),
  );
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new ProjectError(`"${query}" matches ${hits.length} failures in run ${run.id}: ${hits.map((h) => `"${h.title}"`).join(", ")}. Say which.`);
  }
  const passed = run.tests.find((t) => t.title.toLowerCase().includes(q));
  if (passed) throw new ProjectError(`"${passed.title}" didn't fail in run ${run.id} — it ${passed.status}.`);
  throw new ProjectError(`No failure matching "${query}" in run ${run.id}.`);
}

function fullSnapshot(project: Project, test: RunTest): string | undefined {
  if (!test.evidence.errorContext) return undefined;
  const text = fs.readFileSync(path.join(project.root, test.evidence.errorContext), "utf8");
  return /```yaml\n([\s\S]*?)```/.exec(text)?.[1];
}

/** The snapshot, trimmed to its main content — enough to see the page, not a wall of YAML. */
function snapshotOf(project: Project, test: RunTest): string | undefined {
  const s = fullSnapshot(project, test);
  if (!s) return undefined;
  const lines = s.split("\n").filter((l) => l.trim() && !/^\s*- \/url:/.test(l));
  const main = lines.findIndex((l) => /^\s*- main\b/.test(l));
  const from = main >= 0 ? main : 0;
  return lines.slice(from, from + 30).join("\n") + (lines.length - from > 30 ? "\n…" : "");
}

function sourceLines(project: Project, test: RunTest): { failingLine?: string; body: string[] } {
  const file = path.join(project.root, test.file);
  if (!fs.existsSync(file)) return { body: [] };
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const start = test.line - 1;
  let end = start;
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    depth += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
    end = i;
    if (i > start && depth <= 0) break;
  }
  return {
    ...(test.error?.line && test.error.file === test.file ? { failingLine: lines[test.error.line - 1]?.trim() } : {}),
    body: lines.slice(start, end + 1),
  };
}

function caseApproved(project: Project, caseId: string): boolean {
  const dir = path.join(project.root, "proofwright", "cases");
  if (!fs.existsSync(dir)) return false;
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .some((f) => {
      const ledger = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { approvals?: Record<string, unknown> };
      return Boolean(ledger.approvals?.[caseId]);
    });
}

function draftBug(project: Project, test: RunTest, d: Diagnosis, source: { body: string[] }): string {
  const caseFile = test.caseId ? findCaseFile(project, test.caseId) : undefined;
  const steps = caseFile
    ? `Steps: see ${test.caseId} in \`${caseFile}\`.`
    : ["Steps (from the test):", "```ts", ...source.body.map((l) => l.replace(/\s+$/, "")), "```"].join("\n");
  return [
    `**Title:** ${test.title.replace(/^TC-\d+ · /, "")} — ${d.received !== undefined ? `shows ${d.received}, expected ${d.expected}` : d.summary}`,
    "",
    steps,
    "",
    `**Expected:** ${d.expected ?? "(see the test)"}`,
    `**Actual:** ${d.received ?? d.summary}`,
    "",
    `**Evidence:** ${[test.evidence.screenshot, test.evidence.trace].filter(Boolean).map((e) => `\`${e}\``).join(", ") || "none kept"}`,
    `**Found by:** \`${test.file}:${test.line}\`${test.caseId ? ` (${test.caseId})` : ""}`,
  ].join("\n");
}

function findCaseFile(project: Project, caseId: string): string | undefined {
  const dir = path.join(project.root, "proofwright", "cases");
  if (!fs.existsSync(dir)) return undefined;
  const hit = fs.readdirSync(dir).find((f) => f.endsWith(".md") && fs.readFileSync(path.join(dir, f), "utf8").includes(`## ${caseId} · `));
  return hit ? `proofwright/cases/${hit}` : undefined;
}

function renderReport(
  run: Run,
  prev: Run | undefined,
  changes: ReturnType<typeof compare>,
  diagnoses: ReportData["diagnoses"],
): string {
  const out: string[] = [];
  const list = (ts: RunTest[]) => ts.map((t) => `"${t.title}"`).join(", ");
  if (run.focused) {
    out.push(
      `**Only part of the selection ran.** Playwright ran only the tests marked \`test.only\` (${run.focused.map((f) => `[${f}](${f})`).join(", ")}); the other tests in the selection didn't run, so this report can't say whether they pass.`,
      "",
    );
  }
  if (run.errors.length > 0) out.push("**Playwright reported for the whole run:**", ...run.errors.map((e) => `- ${e}`), "");
  if (prev) {
    const parts = [
      changes.newFailures.length > 0 ? `new failures: ${list(changes.newFailures)}` : "no new failures",
      ...(changes.fixed.length > 0 ? [`fixed: ${list(changes.fixed)}`] : []),
      ...(changes.stillFailing.length > 0 ? [`${changes.stillFailing.length} still failing`] : []),
      ...(changes.newTests.length > 0 ? [`${count(changes.newTests.length, "new test")}`] : []),
    ];
    out.push(`**Since the last run**${run.git && prev.git && run.git.head !== prev.git.head ? " (the code changed)" : ""}: ${parts.join("; ")}.`, "");
  }
  if (diagnoses.length > 0) {
    out.push("| Test | What it looks like | Evidence |", "|---|---|---|");
    for (const { test, title, diagnosis } of diagnoses) {
      const t = run.tests.find((x) => x.id === test)!;
      const where = t.error?.line ? `${t.error.file}:${t.error.line}` : `${t.file}:${t.line}`;
      out.push(
        `| [${esc(title)}](${where}) | **${cap(diagnosis.kind)}** (${diagnosis.confidence}): ${esc(diagnosis.summary)} | ${t.evidence.screenshot ? `[screenshot](${t.evidence.screenshot})` : "—"} |`,
      );
    }
    out.push("");
  }
  const byCase = run.tests.filter((t) => t.caseId);
  const failedCases = byCase.filter((t) => t.status === "failed" || t.status === "flaky").map((t) => t.caseId);
  if (byCase.length > 0) {
    out.push(`**Test cases:** ${byCase.length - failedCases.length} passed${failedCases.length > 0 ? `, ${failedCases.length} failed (${failedCases.join(", ")})` : ""}.`);
  }
  return out.join("\n").trim();
}

/** What to do about each kind of failure, in one line. */
const TODO: Record<Diagnosis["kind"], string> = {
  "app bug": "report it as a bug in the app (explain drafts the report). Don't change the test to make it pass.",
  "test bug": "fix the test (explain shows the change it needs).",
  flaky: "find why it passes only sometimes (explain shows where to look).",
  environment: "check that the app or service is running and reachable, then run again.",
  unclear: "look at the screenshot and tell me what you see.",
};

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function cap(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

function article(kind: string): string {
  return kind === "unclear" ? "unclear" : /^[aeiou]/.test(kind) ? `an ${kind}` : `a ${kind}`;
}

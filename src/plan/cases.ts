/**
 * Test cases — the tester's view of Playwright's plan.
 *
 * Each test in the planner's plan becomes a numbered test case (TC-001 …)
 * written as Action · Data · Expected result, the shape Xray and Zephyr use
 * for manual test steps. Numbers are stable: a case keeps its number when the
 * plan is saved again. What's open is listed — a case that checks nothing can't
 * be approved; unclear steps are questions — and approvals are recorded with the
 * tester's words, tied to the case's exact content: if the plan changes a case,
 * its approval no longer applies.
 */
import { createHash } from "node:crypto";
import type { PlanTest, TestPlan } from "./playwright-plan.js";

export interface CaseStep {
  action: string;
  data: string[];
  expected: string[];
}

export interface TestCase {
  id: string;
  name: string;
  suite: string;
  seedFile: string;
  /** Where Playwright's generator writes the test. */
  file: string;
  steps: CaseStep[];
  /** Fingerprint of the case's content; an approval is for this exact content. */
  fingerprint: string;
  /** Reasons the case can't be approved yet. */
  blocking: string[];
  /** Things to settle; approving means accepting them as they are. */
  questions: string[];
  approval?: Approval;
}

export interface Approval {
  /** YYYY-MM-DD */
  on: string;
  /** The tester's own words. */
  words: string;
  /** How the approval reached Proofwright. */
  how: "asked you directly" | "your words, relayed by the AI client";
  fingerprint: string;
}

/** What is kept between runs: stable numbers, and the approvals. */
export interface CaseLedger {
  plan: string;
  request?: string;
  ids: Record<string, string>;
  approvals: Record<string, Approval>;
}

/** Verbs whose quoted words are values typed or picked — test data — not labels clicked. */
const INPUT_VERB = /\b(type|types|typed|typing|enter|enters|entered|fill|fills|filled|input|select|selects|selected|choose|chooses|chosen|set|sets|paste|pastes|search|searches|upload|uploads)\b/i;
const QUOTED = /"([^"]*)"|“([^”]*)”|'([^']+)'/g;
const VAGUE = /\b(works?|working) (correctly|properly|fine|as expected)\b|\bas expected\b|\bshould work\b|\bis correct\b|\bproperly\b/i;

const keyOf = (suite: string, test: PlanTest) => `${suite} › ${test.name}`;

export function buildCases(plan: TestPlan, ledger: CaseLedger): TestCase[] {
  let next = 1 + Math.max(0, ...Object.values(ledger.ids).map((id) => Number(id.slice(3)) || 0));
  const cases: TestCase[] = [];
  for (const suite of plan.suites) {
    for (const test of suite.tests) {
      const key = keyOf(suite.name, test);
      const id = (ledger.ids[key] ??= `TC-${String(next++).padStart(3, "0")}`);
      const steps = test.steps.map((s) => ({
        action: s.perform ?? "",
        data: s.perform && INPUT_VERB.test(s.perform) ? quoted(s.perform) : [],
        expected: s.expect,
      }));
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ name: test.name, suite: suite.name, file: test.file, steps: test.steps }))
        .digest("hex")
        .slice(0, 16);
      const c: TestCase = {
        id,
        name: test.name,
        suite: suite.name,
        seedFile: suite.seedFile,
        file: test.file,
        steps,
        fingerprint,
        blocking: [],
        questions: [],
      };
      assess(c);
      const approval = ledger.approvals[id];
      if (approval && approval.fingerprint === fingerprint) c.approval = approval;
      cases.push(c);
    }
  }
  return cases;
}

function quoted(text: string): string[] {
  return [...text.matchAll(QUOTED)].map((m) => m[1] ?? m[2] ?? m[3]).filter((v) => v !== undefined);
}

function assess(c: TestCase): void {
  if (c.steps.length === 0 || c.steps.every((s) => s.expected.length === 0)) {
    c.blocking.push("it has no expected result anywhere, so it could never fail");
  }
  if (!c.file) c.blocking.push("it has no test file to be written to");
  c.steps.forEach((s, i) => {
    const n = i + 1;
    if (!s.action && s.expected.length === 0) c.questions.push(`Step ${n} is empty.`);
    if (s.action && INPUT_VERB.test(s.action) && s.data.length === 0) {
      c.questions.push(`Step ${n} types or picks a value but doesn't say which: "${s.action}".`);
    }
    for (const e of s.expected) {
      if (VAGUE.test(e)) c.questions.push(`Step ${n} expects "${e}" — what exactly should the page show?`);
    }
  });
  const last = c.steps[c.steps.length - 1];
  if (last && last.action && last.expected.length === 0 && c.blocking.length === 0) {
    c.questions.push(`The last step ("${last.action}") checks nothing after it.`);
  }
}

// ---------------------------------------------------------------- the tester's file

/** The test cases as Markdown, for the tester — generated; the plan is the source. */
export function renderCases(plan: TestPlan, planPath: string, cases: TestCase[], request?: string): string {
  const approved = cases.filter((c) => c.approval).length;
  const out: string[] = [
    "---",
    `feature: ${yamlString(plan.name)}`,
    ...(request ? [`request: ${yamlString(request)}`] : []),
    `plan: ${planPath}`,
    `status: ${approved === cases.length ? "approved" : approved > 0 ? "partly approved" : "draft"}`,
    "jira: []",
    "---",
    "",
    `# ${plan.name}`,
    "",
    `*Made by Proofwright from Playwright's plan \`${planPath}\`. To change a case, change the plan and run \`approve_plan\` again — a changed case needs approving again.*`,
  ];
  for (const c of cases) {
    const state = c.approval
      ? `approved ${c.approval.on} — "${c.approval.words}" (${c.approval.how})`
      : c.blocking.length > 0
        ? "can't be approved yet"
        : "draft";
    out.push(
      "",
      `## ${c.id} · ${c.name}`,
      `Status: ${state} · Suite: ${c.suite} · Test: \`${c.file || "—"}\``,
      "",
      "| # | Action | Data | Expected result |",
      "|---|---|---|---|",
      ...c.steps.map(
        (s, i) =>
          `| ${i + 1} | ${cell(s.action || "—")} | ${cell(s.data.map((d) => `"${d}"`).join(", ") || "—")} | ${cell(s.expected.join("; ") || "—")} |`,
      ),
    );
  }
  const open = cases.flatMap((c) => [
    ...c.blocking.map((b) => `**${c.id}** can't be approved yet: ${b}.`),
    ...c.questions.map((q) => `**${c.id}**: ${q}`),
  ]);
  if (open.length > 0) out.push("", "## Open questions", "", ...open.map((q, i) => `${i + 1}. ${q}`));
  out.push("");
  return out.join("\n");
}

/** Only the approved cases, as a plan Playwright's generator reads — each test titled with its case number. */
export function approvedPlan(plan: TestPlan, cases: TestCase[]): TestPlan | null {
  const approved = new Map(cases.filter((c) => c.approval).map((c) => [`${c.suite} › ${c.name}`, c]));
  if (approved.size === 0) return null;
  const suites = plan.suites
    .map((s) => ({
      ...s,
      tests: s.tests
        .filter((t) => approved.has(keyOf(s.name, t)))
        .map((t) => ({ ...t, name: `${approved.get(keyOf(s.name, t))!.id} · ${t.name}` })),
    }))
    .filter((s) => s.tests.length > 0);
  return { name: `${plan.name} — approved test cases`, overview: plan.overview, suites };
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}

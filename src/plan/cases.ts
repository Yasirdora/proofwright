/**
 * Test cases — the tester's view of Playwright's plan.
 *
 * Each test in the planner's plan becomes a numbered test case (TC-001 …)
 * written as Action · Data · Expected result, the shape Xray and Zephyr use
 * for manual test steps. Numbers are stable: a case keeps its number when the
 * plan is saved again. What's open is listed — a case that checks nothing can't
 * be approved; a step that types something without saying what, a vague
 * expected result, or one the requirements don't promise, is a question — and
 * approvals are recorded with the tester's words, tied to the case's exact
 * content: if the plan changes a case, its approval no longer applies.
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
  /** The tester approved other cases of the plan and left this one out. */
  leftOut?: boolean;
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
  /** Cases the tester chose not to approve; they aren't asked about again. */
  leftOut?: string[];
}

/**
 * A step that types or picks a value: one of these verbs at the start of a
 * sentence or clause ("…, type SAVE10 into …", "and change the quantity to 4") —
 * not anywhere in the text, where "set" in "Pencil set" is a product's name.
 */
const INPUT_CLAUSE =
  /(?:^|[.;:,!?]\s+|\b(?:and|then)\s+)(type|types|enter|enters|fill in|fill|fills|input|paste|pastes|search for|search|select|selects|choose|chooses|pick|picks|set|sets|change|changes|update|updates|upload|uploads)\b(.*?)(?=[.;!?](?:\s|$)|\s+(?:and|then)\s+(?:click|press|tap|go|open|select|choose|pick|type|enter|fill|check|uncheck|submit|wait|scroll|navigate|add|remove|change|update|apply|save|log|sign|drag|hover|upload|search|set|clear)\b|$)/gi;
const QUOTED = /"([^"]*)"|“([^”]*)”|'([^']+)'/g;
/** Where the value ends and the field begins: "type SAVE10 | into the Coupon code field". */
const FIELD = /\s+(?:into|in|on|for|from|as|at)\s+(?:the|a|an|this|that|its|your)\b.*$|\s+(?:into|in)\s+.*$/i;
/** A phrase that points back at data an earlier step made: "the email used to sign up". */
const EARLIER = /\b(?:used|same|earlier|above|before|previous|from step|created|registered|signed up|you (?:entered|typed|chose))\b/i;
/** A phrase that describes a value instead of giving it: "a valid email", "the password". */
const DESCRIBED = /^(?:a|an|some|any|another|the|your|his|her|their|its|valid|invalid|random|long|short|new|different|wrong|correct)\b/i;
/** A word that is a value on its own: SAVE10, NOPE, 4, €20.00, a@b.test. */
const CONCRETE = /^(?:[\p{Lu}\d][\p{Lu}\d_-]*\d*|[\p{Lu}]{2,}[\p{Lu}\d_-]*|[-+]?[€$£]?\d[\d.,:/-]*[€$£%]?|\S+@\S+\.\S+|https?:\/\/\S+)$/u;
/** An expected result the planner marked as seen on the page but not promised by the requirements. */
const NOT_PROMISED = /^\s*\(?not promised\)?\s*[:—–-]\s*/i;
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
        data: valuesOf(s.perform ?? "").values,
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
      else if (ledger.leftOut?.includes(id)) c.leftOut = true;
      cases.push(c);
    }
  }
  return cases;
}

function quoted(text: string): string[] {
  return [...text.matchAll(QUOTED)].map((m) => m[1] ?? m[2] ?? m[3]).filter((v) => v !== undefined);
}

/**
 * The values a step types or picks, and whether it types something without
 * saying what. Quoted values count ("Type "  save10  " …"), and so do unquoted
 * ones, as Playwright's planner writes them: "type SAVE10 into …", "change the
 * quantity to 4", "type a made-up code, NOPE, into …". "Type a valid email" gives
 * no value: that's a question.
 */
export function valuesOf(action: string): { values: string[]; unsaid: boolean } {
  const values: string[] = [];
  let unsaid = false;
  for (const m of action.matchAll(INPUT_CLAUSE)) {
    const verb = m[1].toLowerCase();
    const clause = m[2];
    // Quoted words count only in a step that types or picks: a label clicked isn't data.
    if (quoted(clause).length > 0) {
      values.push(...quoted(clause));
      continue;
    }
    let phrase = clause.replace(FIELD, "").trim();
    if (/^(?:set|sets|change|changes|update|updates)$/.test(verb)) {
      const to = / to\s+(.+)$/i.exec(clause);
      phrase = to ? to[1].replace(FIELD, "").trim() : "";
    }
    phrase = phrase.replace(/^[,:\s]+|[,.:;\s]+$/g, "");
    const words = phrase.split(/[\s,]+/).filter(Boolean);
    const concrete = words.filter((w) => CONCRETE.test(w.replace(/[()]/g, "")));
    if (phrase && (!DESCRIBED.test(phrase) || EARLIER.test(phrase))) values.push(phrase);
    else if (concrete.length > 0) values.push(...concrete);
    else unsaid = true;
  }
  return { values: [...new Set(values)], unsaid };
}

/** The expected result as the generator should check it, without the planner's "not promised" mark. */
export function promised(expected: string): string {
  return expected.replace(NOT_PROMISED, "");
}

function assess(c: TestCase): void {
  if (c.steps.length === 0 || c.steps.every((s) => s.expected.length === 0)) {
    c.blocking.push("it has no expected result anywhere, so it could never fail");
  }
  if (!c.file) c.blocking.push("it has no test file to be written to");
  c.steps.forEach((s, i) => {
    const n = i + 1;
    if (!s.action && s.expected.length === 0) c.questions.push(`Step ${n} is empty.`);
    if (s.action && valuesOf(s.action).unsaid) {
      c.questions.push(`Step ${n} types or picks something but doesn't say what: "${s.action}".`);
    }
    for (const e of s.expected) {
      if (NOT_PROMISED.test(e)) {
        c.questions.push(`Step ${n} expects "${promised(e)}", which the requirements don't promise. Should the app do this?`);
      } else if (VAGUE.test(e)) {
        c.questions.push(`Step ${n} expects "${e}": what exactly should the page show?`);
      }
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
        : c.leftOut
          ? "left out by you"
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
  const open = cases
    .filter((c) => !c.approval && !c.leftOut)
    .flatMap((c) => [...c.blocking.map((b) => `**${c.id}** can't be approved yet: ${b}.`), ...c.questions.map((q) => `**${c.id}**: ${q}`)]);
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
        .map((t) => ({
          ...t,
          name: `${approved.get(keyOf(s.name, t))!.id} · ${t.name}`,
          // Approved by the tester: what the planner marked "not promised" is now expected.
          steps: t.steps.map((st) => ({ ...st, expect: st.expect.map(promised) })),
        })),
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

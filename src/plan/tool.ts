/**
 * The `approve_plan` tool: Playwright's plan → test cases the tester reads,
 * and the tester's approval, case by case. Only approved cases reach
 * Playwright's generator, in a plan of their own (specs/<name>.approved.md).
 *
 * Approval comes from the tester, never from the AI: when the client can show
 * a form (MCP elicitation), Proofwright asks the tester directly; otherwise it
 * needs the tester's own words, and records how the approval arrived.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Answer, count } from "../answer.js";
import { type Project, ProjectError } from "../project.js";
import { approvedPlan, type Approval, buildCases, type CaseLedger, renderCases, type TestCase } from "./cases.js";
import { parsePlan, PlanFormatError, renderPlan } from "./playwright-plan.js";

export interface ApprovePlanInput {
  /** The plan Playwright's planner saved, e.g. specs/coupons.plan.md. */
  plan: string;
  /** The tester's request, in their words — kept with the test cases. */
  request?: string;
  /** Case numbers to approve, or ["all"]. */
  approve?: string[];
  /** The tester's own words of approval (when the client can't show a form). */
  words?: string;
}

/**
 * Asks the tester directly, in a form with Accept and Decline: resolves to their
 * words when they accept, or null when they decline or close it.
 */
export type AskTester = (message: string) => Promise<{ words: string } | null>;

export interface ApprovePlanData {
  plan: string;
  cases: TestCase[];
  casesFile: string;
  approvedPlan?: string;
  approvedNow: string[];
}

export async function approvePlan(
  project: Project,
  input: ApprovePlanInput,
  ask?: AskTester,
  today = new Date(),
): Promise<Answer<ApprovePlanData>> {
  const planAbs = project.resolve(input.plan);
  const planRel = project.relative(planAbs);
  if (project.isIgnored(planRel)) throw new ProjectError(`${planRel} is off limits (proofwright/config.json).`);
  if (!fs.existsSync(planAbs)) throw new ProjectError(`There's no plan at ${planRel}. Ask Playwright's planner to save one first.`);
  let plan;
  try {
    plan = parsePlan(fs.readFileSync(planAbs, "utf8"));
  } catch (err) {
    if (err instanceof PlanFormatError) throw new ProjectError(`${planRel}: ${err.message}`);
    throw err;
  }

  const slug = path.basename(planRel).replace(/\.plan\.md$|\.md$/i, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const ledgerFile = project.stateFile("cases", `${slug}.json`);
  const ledger: CaseLedger = fs.existsSync(ledgerFile)
    ? JSON.parse(fs.readFileSync(ledgerFile, "utf8"))
    : { plan: planRel, ids: {}, approvals: {} };
  if (input.request) ledger.request = input.request;
  let cases = buildCases(plan, ledger);

  // ---- approval
  const did: string[] = [`Read Playwright's plan \`${planRel}\`: ${count(cases.length, "test")} in ${count(plan.suites.length, "suite")}.`];
  const approvedNow: string[] = [];
  const refused: string[] = [];
  if (input.approve && input.approve.length > 0) {
    const all = input.approve.some((a) => a.toLowerCase() === "all");
    const wanted = all
      ? cases.filter((c) => !c.approval)
      : input.approve.map((id) => {
          const c = cases.find((x) => x.id.toLowerCase() === id.trim().toLowerCase());
          if (!c) throw new ProjectError(`There's no test case ${id} in ${planRel}.`);
          return c;
        });
    const ready = wanted.filter((c) => c.blocking.length === 0);
    refused.push(...wanted.filter((c) => c.blocking.length > 0).map((c) => c.id));
    if (ready.length > 0) {
      const approval = await getApproval(ready, planRel, input.words, ask, today);
      if (approval) {
        for (const c of ready) ledger.approvals[c.id] = { ...approval, fingerprint: c.fingerprint };
        approvedNow.push(...ready.map((c) => c.id));
        // The cases they didn't pick are left out on purpose: not asked about again.
        if (!all) {
          const others = cases.filter((c) => !c.approval && !approvedNow.includes(c.id) && c.blocking.length === 0).map((c) => c.id);
          ledger.leftOut = [...new Set([...(ledger.leftOut ?? []).filter((id) => !approvedNow.includes(id)), ...others])];
        } else {
          ledger.leftOut = [];
        }
        did.push(`Recorded your approval (${approval.how}): "${approval.words}".`);
      } else {
        did.push("Asked you in the form; you declined, so nothing was approved.");
      }
      cases = buildCases(plan, ledger);
    }
  }

  // ---- files
  fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
  const casesFile = project.stateFile("cases", `${slug}.md`);
  fs.writeFileSync(casesFile, renderCases(plan, planRel, cases, ledger.request));
  did.push(`Wrote the test cases to \`${project.relative(casesFile)}\`.`);
  const casesRel = project.relative(casesFile);
  const forGenerator = approvedPlan(plan, cases);
  const approvedFile = path.join(path.dirname(planAbs), `${slug}.approved.md`);
  let approvedRel: string | undefined;
  if (forGenerator) {
    fs.writeFileSync(approvedFile, renderPlan(forGenerator));
    approvedRel = project.relative(approvedFile);
    did.push(`Wrote the approved cases for Playwright's generator to \`${approvedRel}\`.`);
  } else if (fs.existsSync(approvedFile)) {
    fs.rmSync(approvedFile);
    did.push(`Removed \`${project.relative(approvedFile)}\`: no case is approved any more.`);
  }

  const approved = cases.filter((c) => c.approval);
  const leftOut = cases.filter((c) => c.leftOut);
  const blocked = cases.filter((c) => !c.approval && !c.leftOut && c.blocking.length > 0);
  const drafts = cases.filter((c) => !c.approval && !c.leftOut && c.blocking.length === 0);
  const questions = [...blocked, ...drafts].flatMap((c) => c.questions.map((q) => `**${c.id}**: ${q}`));
  const need: string[] = [];
  for (const c of blocked) need.push(`**${c.id}** can't be approved: ${c.blocking.join("; ")}. Change the plan, or leave the case out.`);
  if (refused.length > 0 && blocked.length === 0) need.push(`${refused.join(", ")} can't be approved yet.`);
  if (questions.length > 0) need.push(`Answer the ${questions.length === 1 ? "question" : `${questions.length} questions`} above, or approve the cases as they are.`);
  if (drafts.length > 0) {
    need.push(`Say which cases you approve: all, or by number (${ranges(drafts.map((c) => c.id))}).`);
  }

  const headline =
    approvedNow.length > 0
      ? `Approved ${count(approvedNow.length, "test case")}.${leftOut.length > 0 ? ` Left out: ${ranges(leftOut.map((c) => c.id))}.` : ""}${drafts.length > 0 ? ` ${drafts.length} still to decide.` : ""}`
      : drafts.length + blocked.length === 0
        ? `All ${count(cases.length, "test case")} are decided: ${approved.length} approved${leftOut.length > 0 ? `, ${leftOut.length} left out` : ""}.`
        : `${count(cases.length, "test case")} to check${questions.length > 0 ? `, ${questions.length === 1 ? "1 question" : `${questions.length} questions`} for you` : ""}.`;
  return {
    headline,
    did,
    found: renderSummary(cases, questions, casesRel),
    need,
    next: approvedRel ? `Next: Playwright's generator writes one test per approved case from \`${approvedRel}\`.` : undefined,
    data: { plan: planRel, cases, casesFile: casesRel, ...(approvedRel ? { approvedPlan: approvedRel } : {}), approvedNow },
  };
}

/** "TC-001 – TC-011, TC-013" */
function ranges(ids: string[]): string {
  const nums = ids.map((id) => Number(id.slice(3))).sort((a, b) => a - b);
  const out: string[] = [];
  const tc = (n: number) => `TC-${String(n).padStart(3, "0")}`;
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j - i >= 2 ? `${tc(nums[i])} – ${tc(nums[j])}` : nums.slice(i, j + 1).map(tc).join(", "));
    i = j;
  }
  return out.join(", ");
}

async function getApproval(
  cases: TestCase[],
  planRel: string,
  words: string | undefined,
  ask: AskTester | undefined,
  today: Date,
): Promise<Omit<Approval, "fingerprint"> | null> {
  const on = today.toISOString().slice(0, 10);
  if (ask) {
    const questions = cases.reduce((n, c) => n + c.questions.length, 0);
    const message = [
      `Approve ${count(cases.length, "test case")}?`,
      "",
      ...cases.map((c) => `${c.id} · ${c.name}`),
      "",
      ...(questions > 0 ? [`${questions === 1 ? "1 open question" : `${questions} open questions`} (in the test cases file): approving accepts ${questions === 1 ? "it" : "them"} as ${questions === 1 ? "it is" : "they are"}.`] : []),
      "Accept = approve these cases.   Decline = approve nothing.",
    ].join("\n");
    const answer = await ask(message);
    return answer ? { on, words: answer.words, how: "asked you directly" } : null;
  }
  if (!words || !words.trim()) {
    throw new ProjectError(
      "To approve, I need the tester's own words of approval (this app can't show Proofwright's approval form). Ask the tester, and pass exactly what they said.",
    );
  }
  return { on, words: words.trim(), how: "your words, relayed by the AI client" };
}

function renderSummary(cases: TestCase[], questions: string[], casesFile: string): string {
  const rows = cases.map((c) => {
    const status = c.approval ? "✅ approved" : c.leftOut ? "left out" : c.blocking.length > 0 ? "⛔ can't be approved" : "to decide";
    return `| ${c.id} | ${c.name.replace(/\|/g, "\\|")} | ${status} |`;
  });
  return [
    "| Case | What it checks | Status |",
    "|---|---|---|",
    ...rows,
    ...(questions.length > 0 ? ["", "**Questions**", ...questions.map((q) => `- ${q}`)] : []),
    "",
    `Steps, data and expected results: \`${casesFile}\`.`,
  ].join("\n");
}

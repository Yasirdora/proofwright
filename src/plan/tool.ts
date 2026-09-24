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

/** Asks the tester directly; resolves to their answer, or null when they declined. */
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
        did.push(`Recorded your approval of ${approvedNow.join(", ")} (${approval.how}): "${approval.words}".`);
      } else {
        did.push("Asked you to approve; you didn't, so nothing was approved.");
      }
      cases = buildCases(plan, ledger);
    }
  }

  // ---- files
  fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
  const casesFile = project.stateFile("cases", `${slug}.md`);
  fs.writeFileSync(casesFile, renderCases(plan, planRel, cases, ledger.request));
  did.push(`Wrote the test cases to \`${project.relative(casesFile)}\`.`);
  const forGenerator = approvedPlan(plan, cases);
  const approvedFile = path.join(path.dirname(planAbs), `${slug}.approved.md`);
  let approvedRel: string | undefined;
  if (forGenerator) {
    fs.writeFileSync(approvedFile, renderPlan(forGenerator));
    approvedRel = project.relative(approvedFile);
    did.push(`Wrote the approved cases, as a plan for Playwright's generator, to \`${approvedRel}\`.`);
  } else if (fs.existsSync(approvedFile)) {
    fs.rmSync(approvedFile);
    did.push(`Removed \`${project.relative(approvedFile)}\`: no case is approved any more.`);
  }

  const approved = cases.filter((c) => c.approval);
  const blocked = cases.filter((c) => c.blocking.length > 0);
  const drafts = cases.filter((c) => !c.approval && c.blocking.length === 0);
  const questions = cases.flatMap((c) => c.questions.map((q) => `**${c.id}**: ${q}`));
  const need: string[] = [];
  for (const c of blocked) need.push(`**${c.id}** can't be approved: ${c.blocking.join("; ")}. Change the plan, or drop the case.`);
  if (refused.length > 0 && blocked.length === 0) need.push(`${refused.join(", ")} can't be approved yet.`);
  if (drafts.length > 0) {
    need.push(
      `Approve the cases you're happy with — all of them, or by number (${drafts.map((c) => c.id).join(", ")}) — in your own words.` +
        (questions.length > 0 ? ` Approving accepts the ${count(questions.length, "open question")} below as they are; or answer them first and I'll update the plan.` : ""),
    );
    need.push(...questions);
  }

  return {
    headline:
      approvedNow.length > 0
        ? `Approved ${approvedNow.join(", ")} — ${approved.length} of ${cases.length} cases are approved now.`
        : `${count(cases.length, "test case")} from Playwright's plan: ${approved.length} approved, ${drafts.length} to approve, ${blocked.length} can't be approved yet.`,
    did,
    found: renderSummary(cases, questions),
    need,
    next: approvedRel
      ? `Next: Playwright's generator writes one test per approved case from \`${approvedRel}\`; then I review what it wrote.`
      : undefined,
    data: { plan: planRel, cases, casesFile: project.relative(casesFile), ...(approvedRel ? { approvedPlan: approvedRel } : {}), approvedNow },
  };
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
    const questions = cases.flatMap((c) => c.questions.map((q) => `${c.id}: ${q}`));
    const message = [
      `Proofwright: approve ${count(cases.length, "test case")} from ${planRel}?`,
      "",
      ...cases.map((c) => `${c.id} · ${c.name}`),
      ...(questions.length > 0 ? ["", "Open questions — approving accepts them as they are:", ...questions] : []),
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

function renderSummary(cases: TestCase[], questions: string[]): string {
  const rows = cases.map((c) => {
    const status = c.approval ? `approved ${c.approval.on}` : c.blocking.length > 0 ? "can't be approved yet" : "to approve";
    const checks = c.steps.reduce((n, s) => n + s.expected.length, 0);
    return `| **${c.id}** | ${c.name.replace(/\|/g, "\\|")} | ${c.steps.length} steps, ${count(checks, "check")} | ${status} |`;
  });
  return [
    "| Case | Name | Steps | Status |",
    "|---|---|---|---|",
    ...rows,
    ...(questions.length > 0 ? ["", `${count(questions.length, "open question")} — listed below under "What I need from you".`] : []),
  ].join("\n");
}

/**
 * The guide: where the tester is in each test session, and the one next step.
 *
 * A session is a plan Playwright's planner saved (specs/<name>.plan.md). Its six
 * steps are read from what's already on disk — nothing is kept for the guide
 * itself, so it knows where things stand after a break, a usage limit or a new
 * session, in any AI app:
 *
 *   1 Plan        specs/<name>.plan.md
 *   2 Test cases  proofwright/cases/<name>.json (approve_plan was called)
 *   3 Approval    every case approved or left out, no question open
 *   4 Tests       the approved plan's test files exist
 *   5 Review      review finds nothing in them (it's read-only and quick)
 *   6 Prove       a proof of those files as they are now: the proof keeps each
 *                 file's fingerprint, so a file rewritten with the same text (by
 *                 git, a copy, another tool) is still proven. Older proofs have
 *                 no fingerprints: for them, a file newer than the proof changed.
 *
 * The next step is the first one that isn't done — except review, which is
 * advice: it's listed, and the guide moves on to prove.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Answer, count } from "../answer.js";
import type { Project } from "../project.js";
import { buildCases, type CaseLedger } from "../plan/cases.js";
import { parsePlan } from "../plan/playwright-plan.js";
import { fingerprint } from "../prove/prove.js";
import { review } from "../review/review.js";

export type StepState = "done" | "to do" | "attention";

export interface GuideStep {
  name: string;
  state: StepState;
  /** What's there, in a few words: "17 approved, 1 left out". */
  note: string;
}

export interface GuideSession {
  feature: string;
  plan: string;
  steps: GuideStep[];
  /** The one next step, with what to say. */
  next: string;
  /** Things worth doing that don't block the next step. */
  also: string[];
  updatedAt: number;
}

export interface GuideData {
  sessions: GuideSession[];
}

const MARK: Record<StepState, string> = { done: "✅", "to do": "⬜", attention: "⚠️" };
const START = "Say what to test: `/proofwright <what to test>` — for example `/proofwright check that coupon codes work at checkout`.";

export function guide(project: Project): Answer<GuideData> {
  const specs = path.join(project.root, "specs");
  const plans = fs.existsSync(specs)
    ? fs.readdirSync(specs).filter((f) => f.endsWith(".plan.md") && !project.isIgnored(`specs/${f}`))
    : [];
  const sessions = plans.flatMap((f) => {
    try {
      return [sessionOf(project, `specs/${f}`)];
    } catch {
      return []; // not a plan Playwright's planner wrote
    }
  });
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);

  if (sessions.length === 0) {
    return {
      headline: "Nothing tested here yet.",
      did: ["Looked for plans in specs/. Nothing was run or changed."],
      found: "A test session starts from one plain sentence: Playwright's planner explores the app and drafts a plan, you approve the test cases, Playwright's generator writes the tests, and Proofwright reviews and proves them.",
      need: [START],
      data: { sessions },
    };
  }
  const [latest, ...older] = sessions;
  const done = latest.steps.filter((s) => s.state === "done").length;
  const line = (s: GuideSession) => s.steps.map((st) => `${MARK[st.state]} ${st.name}${st.note ? `: ${st.note}` : ""}`).join(" · ");
  const found = [
    line(latest),
    ...(older.length > 0 ? ["", "**Other sessions**", ...older.map((s) => `- ${s.feature}: ${s.steps.filter((x) => x.state === "done").length} of 6 steps done — next: ${s.next}`)] : []),
  ].join("\n");
  return {
    headline: `${latest.feature}: ${done} of 6 steps done.`,
    did: ["Read what's saved in specs/ and proofwright/, and reviewed the tests. Nothing was run or changed."],
    found,
    need: [latest.next, ...latest.also],
    data: { sessions },
  };
}

function sessionOf(project: Project, planRel: string): GuideSession {
  const planAbs = path.join(project.root, planRel);
  const plan = parsePlan(fs.readFileSync(planAbs, "utf8"));
  const slug = path.basename(planRel).replace(/\.plan\.md$/i, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const touched = [fs.statSync(planAbs).mtimeMs];
  const steps: GuideStep[] = [{ name: "Plan", state: "done", note: "" }];
  const also: string[] = [];
  let next = "";
  const todo = (text: string) => (next ||= text);

  // 2 and 3 — the test cases, and the tester's decisions on them.
  const ledgerFile = path.join(project.root, "proofwright/cases", `${slug}.json`);
  if (!fs.existsSync(ledgerFile)) {
    steps.push({ name: "Test cases", state: "to do", note: "" }, { name: "Approval", state: "to do", note: "" });
    todo('Turn the plan into test cases for you to check: say "show me the test cases".');
  } else {
    touched.push(fs.statSync(ledgerFile).mtimeMs);
    const cases = buildCases(plan, JSON.parse(fs.readFileSync(ledgerFile, "utf8")) as CaseLedger);
    const approved = cases.filter((c) => c.approval).length;
    const leftOut = cases.filter((c) => c.leftOut).length;
    const open = cases.filter((c) => !c.approval && !c.leftOut);
    const questions = open.reduce((n, c) => n + c.questions.length, 0);
    steps.push({ name: "Test cases", state: "done", note: count(cases.length, "case") });
    const decided = `${approved} approved${leftOut > 0 ? `, ${leftOut} left out` : ""}`;
    if (open.length > 0 || approved === 0) {
      steps.push({ name: "Approval", state: approved > 0 ? "attention" : "to do", note: `${decided}, ${open.length} to decide` });
      todo(
        `${questions > 0 ? `Answer the ${questions === 1 ? "question" : `${questions} questions`}, then s` : "S"}ay which cases you approve: all, or by number.`,
      );
    } else {
      steps.push({ name: "Approval", state: "done", note: decided });
    }
  }

  // 4 — the tests the generator wrote for the approved cases.
  const approvedFile = path.join(project.root, "specs", `${slug}.approved.md`);
  const wanted = fs.existsSync(approvedFile) ? [...new Set(parsePlan(fs.readFileSync(approvedFile, "utf8")).suites.flatMap((s) => s.tests.map((t) => t.file)).filter(Boolean))] : [];
  const written = wanted.filter((f) => fs.existsSync(path.join(project.root, f)));
  for (const f of written) touched.push(fs.statSync(path.join(project.root, f)).mtimeMs);
  if (wanted.length === 0 || written.length < wanted.length) {
    steps.push({ name: "Tests", state: "to do", note: wanted.length > 0 ? `${written.length} of ${wanted.length} written` : "" });
    todo('Write the tests for the approved cases: say "write the tests".');
  } else {
    steps.push({ name: "Tests", state: "done", note: `${written.length} written` });
  }

  // 5 — review: advice, not a gate.
  if (written.length === 0) {
    steps.push({ name: "Review", state: "to do", note: "" });
  } else {
    const problems = review(project, written).data.findings.length;
    steps.push({ name: "Review", state: problems > 0 ? "attention" : "done", note: problems > 0 ? `${count(problems, "problem")} to fix` : "no problems" });
    if (problems > 0) also.push(`Also: fix the ${count(problems, "review problem")} — say "fix the review problems" — or leave them.`);
  }

  // 6 — the latest proof of these tests, if it's newer than they are.
  const proof = written.length > 0 ? latestProof(project, written) : undefined;
  if (!proof) {
    steps.push({ name: "Prove", state: "to do", note: "" });
    if (written.length > 0) todo('Prove the tests can fail (it takes a few minutes): say "prove the tests".');
  } else if (written.some((f) => changedSince(project, f, proof))) {
    steps.push({ name: "Prove", state: "attention", note: "the tests changed since" });
    todo('The tests changed since they were proven: say "prove the tests" again.');
  } else {
    touched.push(proof.at);
    const weak = proof.verdicts.filter((v) => v === "misses its own action" || v === "can't fail").length;
    const good = proof.verdicts.filter((v) => v === "catches").length;
    const failing = proof.failing;
    steps.push({
      name: "Prove",
      state: weak + failing > 0 ? "attention" : "done",
      note: [`${good} good`, ...(weak > 0 ? [`${weak} need a better check`] : []), ...(failing > 0 ? [`${failing} fail on the app`] : [])].join(", "),
    });
    if (weak > 0) todo(`Make ${weak === 1 ? "the test" : `the ${weak} tests`} prove flagged check what ${weak === 1 ? "its" : "their"} own step did: say "fix the tests prove flagged".`);
    if (failing > 0) {
      todo(`${count(failing, "test")} ${failing === 1 ? "fails" : "fail"} with nothing broken — most likely bugs in the app: say "explain the failing tests" to get the reasons and bug reports.`);
    }
  }
  todo(`Done. Test something else: \`/proofwright <what to test>\`.`);
  return { feature: plan.name, plan: planRel, steps, next, also, updatedAt: Math.max(...touched) };
}

interface LatestProof {
  at: number;
  verdicts: string[];
  failing: number;
  /** Each proven file's fingerprint; absent in proofs made before fingerprints were kept. */
  files?: Record<string, string>;
}

/** The test file changed since the proof — or wasn't in it. */
function changedSince(project: Project, file: string, proof: LatestProof): boolean {
  const abs = path.join(project.root, file);
  if (!proof.files) return fs.statSync(abs).mtimeMs > proof.at;
  return proof.files[file] !== fingerprint(abs);
}

/** The newest proof that proved any of these test files: its verdicts, and how many failed with nothing broken. */
function latestProof(project: Project, files: string[]): LatestProof | undefined {
  const dir = path.join(project.root, "proofwright/runs/proofs");
  if (!fs.existsSync(dir)) return undefined;
  for (const id of fs.readdirSync(dir).sort().reverse()) {
    const file = path.join(dir, id, "proof.json");
    if (!fs.existsSync(file)) continue;
    let proof: { startedAt?: string; files?: Record<string, string>; tests?: Array<{ file: string; verdict: string; result: string }> };
    try {
      proof = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const mine = (proof.tests ?? []).filter((t) => files.includes(t.file));
    if (mine.length === 0) continue;
    return {
      at: Date.parse(proof.startedAt ?? "") || fs.statSync(file).mtimeMs,
      verdicts: mine.map((t) => t.verdict),
      failing: mine.filter((t) => t.verdict === "not proven" && /already fails with nothing broken/.test(t.result)).length,
      ...(proof.files ? { files: proof.files } : {}),
    };
  }
  return undefined;
}

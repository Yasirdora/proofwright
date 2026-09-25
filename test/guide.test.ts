/**
 * The guide: where a test session is, read from what's saved, and the one next step.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { renderAnswer } from "../src/answer.js";
import { guide } from "../src/guide/guide.js";
import { renderPlan } from "../src/plan/playwright-plan.js";
import { approvePlan } from "../src/plan/tool.js";
import { Project } from "../src/project.js";
import { COUPONS } from "./fixtures.js";

const TODAY = new Date("2026-09-25T10:00:00Z");

function project(): Project {
  return new Project(fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-guide-")));
}
const write = (p: Project, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(p.root, rel)), { recursive: true });
  fs.writeFileSync(path.join(p.root, rel), text);
};
const steps = (p: Project) => guide(p).data.sessions[0].steps.map((s) => `${s.name}:${s.state}`).join(" ");

const CLEAN_TEST = (title: string) => `import { expect, test } from "@playwright/test";

test("${title}", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Products" })).toBeVisible();
});
`;

/** A proof of the given test files, as prove saves it. */
function proof(p: Project, id: string, tests: Array<{ file: string; verdict: string; result?: string }>, startedAt = new Date().toISOString()) {
  write(p, `proofwright/runs/proofs/${id}/proof.json`, JSON.stringify({ id, startedAt, tests: tests.map((t) => ({ title: t.file, line: 1, result: "", ...t })) }));
}

test("guide: with nothing yet, it says how to start", () => {
  const a = guide(project());
  assert.equal(a.headline, "Nothing tested here yet.");
  assert.deepEqual(a.need, ["Say what to test: `/proofwright <what to test>` — for example `/proofwright check that coupon codes work at checkout`."]);
});

test("guide: follows a session step by step, from what's saved — plan, cases, approval, tests, review, prove", async () => {
  const p = project();
  write(p, "specs/coupons.plan.md", renderPlan(COUPONS));
  let a = guide(p);
  assert.equal(a.headline, "Checkout coupons: 1 of 6 steps done.");
  assert.equal(steps(p), "Plan:done Test cases:to do Approval:to do Tests:to do Review:to do Prove:to do");
  assert.equal(a.need[0], 'Turn the plan into test cases for you to check: say "show me the test cases".');

  await approvePlan(p, { plan: "specs/coupons.plan.md" }, undefined, TODAY);
  a = guide(p);
  assert.equal(steps(p), "Plan:done Test cases:done Approval:to do Tests:to do Review:to do Prove:to do");
  assert.equal(a.need[0], "Answer the 3 questions, then say which cases you approve: all, or by number.");

  // TC-003 can't be approved (it checks nothing): approving the rest leaves it open.
  await approvePlan(p, { plan: "specs/coupons.plan.md", approve: ["TC-001", "TC-002"], words: "yes" }, undefined, TODAY);
  assert.match(guide(p).found, /⚠️ Approval: 2 approved, 1 to decide/);

  // With TC-003 dropped from the plan, every case is decided.
  const two = structuredClone(COUPONS);
  two.suites[0].tests.pop();
  write(p, "specs/coupons.plan.md", renderPlan(two));
  a = guide(p);
  assert.equal(steps(p), "Plan:done Test cases:done Approval:done Tests:to do Review:to do Prove:to do");
  assert.equal(a.need[0], 'Write the tests for the approved cases: say "write the tests".');
  assert.match(a.found, /⬜ Tests: 0 of 2 written/);

  // The generator writes the two tests: review runs on them; prove is next.
  const files = two.suites[0].tests.map((t) => t.file);
  write(p, files[0], CLEAN_TEST("TC-001 · A valid coupon lowers the total"));
  write(p, files[1], CLEAN_TEST("TC-002 · An expired coupon is refused").replace("  await page.goto", '  await page.waitForTimeout(500);\n  await page.goto'));
  a = guide(p);
  assert.equal(steps(p), "Plan:done Test cases:done Approval:done Tests:done Review:attention Prove:to do");
  assert.deepEqual(a.need, [
    'Prove the tests can fail (it takes a few minutes): say "prove the tests".',
    'Also: fix the 1 review problem — say "fix the review problems" — or leave them.',
  ]);

  // A proof: one test needs a better check, one fails on the app.
  proof(p, "2026-09-25T11-00-00-000", [
    { file: files[0], verdict: "misses its own action" },
    { file: files[1], verdict: "not proven", result: "Can't be checked: it already fails with nothing broken (…)." },
  ]);
  a = guide(p);
  assert.match(a.found, /⚠️ Prove: 0 good, 1 need a better check, 1 fail on the app/);
  assert.equal(a.need[0], 'Make the test prove flagged check what its own step did: say "fix the tests prove flagged".');

  // Strengthened and proven again: only the app's failure is left.
  proof(p, "2026-09-25T12-00-00-000", [
    { file: files[0], verdict: "catches" },
    { file: files[1], verdict: "not proven", result: "Can't be checked: it already fails with nothing broken (…)." },
  ]);
  assert.equal(guide(p).need[0], '1 test fails with nothing broken — most likely bugs in the app: say "explain the failing tests" to get the reasons and bug reports.');

  // A test changed after its proof: prove again.
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(p.root, files[0]), later, later);
  assert.equal(guide(p).need[0], 'The tests changed since they were proven: say "prove the tests" again.');

  // Everything good: done.
  proof(p, "2026-09-25T13-00-00-000", files.map((file) => ({ file, verdict: "catches" })), new Date(Date.now() + 120_000).toISOString());
  a = guide(p);
  assert.equal(a.headline, "Checkout coupons: 5 of 6 steps done.", "review still has its problem");
  assert.equal(a.need[0], "Done. Test something else: `/proofwright <what to test>`.");
  assert.match(renderAnswer(a), /^\*\*Checkout coupons: 5 of 6 steps done\.\*\*\n\n✅ Plan · ✅ Test cases: 2 cases · ✅ Approval: 2 approved · ✅ Tests: 2 written · ⚠️ Review: 1 problem to fix · ✅ Prove: 2 good/);
});

test("guide: several sessions — the latest first, the others with their next step", async () => {
  const p = project();
  write(p, "specs/coupons.plan.md", renderPlan(COUPONS));
  await approvePlan(p, { plan: "specs/coupons.plan.md" }, undefined, TODAY);
  const signup = structuredClone(COUPONS);
  signup.name = "Sign-up form";
  write(p, "specs/signup.plan.md", renderPlan(signup));
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(p.root, "specs/signup.plan.md"), later, later);
  const a = guide(p);
  assert.equal(a.headline, "Sign-up form: 1 of 6 steps done.");
  assert.match(a.found, /\*\*Other sessions\*\*\n- Checkout coupons: 2 of 6 steps done — next: Answer the 3 questions/);
  // A file in specs/ that isn't a plan Playwright wrote is passed over.
  write(p, "specs/notes.plan.md", "# not a plan\n");
  assert.equal(guide(p).data.sessions.length, 2);
});

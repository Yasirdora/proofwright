import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { renderAnswer } from "../src/answer.js";
import { renderPlan, type TestPlan } from "../src/plan/playwright-plan.js";
import { approvePlan } from "../src/plan/tool.js";
import { Project, ProjectError } from "../src/project.js";
import { COUPONS } from "./fixtures.js";

const TODAY = new Date("2026-09-24T10:00:00Z");

function project(plan: TestPlan = COUPONS, config?: unknown): Project {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-approve-"));
  fs.mkdirSync(path.join(dir, "specs"));
  fs.writeFileSync(path.join(dir, "specs/coupons.plan.md"), renderPlan(plan));
  if (config) {
    fs.mkdirSync(path.join(dir, "proofwright"));
    fs.writeFileSync(path.join(dir, "proofwright/config.json"), JSON.stringify(config));
  }
  return new Project(dir);
}
const read = (p: Project, rel: string) => fs.readFileSync(path.join(p.root, rel), "utf8");
const exists = (p: Project, rel: string) => fs.existsSync(path.join(p.root, rel));

test("approve_plan: first shows the cases and what's open — nothing is approved", async () => {
  const p = project();
  const a = await approvePlan(p, { plan: "specs/coupons.plan.md", request: "check that coupon codes work at checkout" }, undefined, TODAY);
  assert.equal(a.headline, "3 test cases from Playwright's plan: 0 approved, 2 to approve, 1 can't be approved yet.");
  assert.ok(a.need[0].startsWith("**TC-003** can't be approved: it has no expected result anywhere"));
  assert.ok(a.need.some((n) => n.startsWith("Approve the cases you're happy with") && n.includes("TC-001, TC-002")));
  assert.equal(exists(p, "specs/coupons.approved.md"), false);
  const cases = read(p, "proofwright/cases/coupons.md");
  assert.match(cases, /^request: "check that coupon codes work at checkout"$/m);
  assert.match(cases, /^## TC-001 · A valid coupon lowers the total$/m);
  assert.match(cases, /\| 3 \| Type "SAVE10" in the Coupon code field and click Apply \| "SAVE10" \| The discount shows −€1\.20; The total shows €10\.80 \|/);
  assert.match(cases, /## Open questions/);
  assert.ok(renderAnswer(a).includes("### What I need from you"));
});

test("approve_plan: approving needs the tester's own words when no form can be shown", async () => {
  const p = project();
  await assert.rejects(
    () => approvePlan(p, { plan: "specs/coupons.plan.md", approve: ["TC-001"] }, undefined, TODAY),
    (e: unknown) => e instanceof ProjectError && /tester's own words/.test((e as Error).message),
  );
  assert.equal(exists(p, "specs/coupons.approved.md"), false, "nothing approved");
});

test("approve_plan: with the tester's words, only the approved cases go to the generator", async () => {
  const p = project();
  const a = await approvePlan(p, { plan: "specs/coupons.plan.md", approve: ["TC-001"], words: "TC-001 looks right, go" }, undefined, TODAY);
  assert.deepEqual(a.data.approvedNow, ["TC-001"]);
  assert.equal(a.data.approvedPlan, "specs/coupons.approved.md");
  const approved = read(p, "specs/coupons.approved.md");
  assert.match(approved, /^#### 1\.1\. TC-001 · A valid coupon lowers the total$/m);
  assert.doesNotMatch(approved, /expired/);
  assert.match(read(p, "proofwright/cases/coupons.md"), /Status: approved 2026-09-24 — "TC-001 looks right, go" \(your words, relayed by the AI client\)/);
});

test("approve_plan: asked directly, the tester's answer decides — the AI's words don't", async () => {
  const p = project();
  let asked = "";
  const yes = await approvePlan(
    p,
    { plan: "specs/coupons.plan.md", approve: ["all"], words: "the AI says yes" },
    async (message) => ((asked = message), { words: "Approved in Proofwright's form." }),
    TODAY,
  );
  assert.deepEqual(yes.data.approvedNow, ["TC-001", "TC-002"], "all approvable cases; TC-003 can't be");
  assert.match(asked, /^Proofwright: approve 2 test cases from specs\/coupons\.plan\.md\?/);
  assert.match(asked, /Open questions — approving accepts them as they are:/);
  assert.doesNotMatch(read(p, "proofwright/cases/coupons.md"), /the AI says yes/);
  assert.match(read(p, "proofwright/cases/coupons.md"), /\(asked you directly\)/);

  const q = project();
  const no = await approvePlan(q, { plan: "specs/coupons.plan.md", approve: ["TC-001"] }, async () => null, TODAY);
  assert.deepEqual(no.data.approvedNow, []);
  assert.ok(no.did.some((d) => d.includes("you didn't, so nothing was approved")));
  assert.equal(exists(q, "specs/coupons.approved.md"), false);
});

test("approve_plan: a case that checks nothing can't be approved, even when asked for", async () => {
  const p = project();
  const a = await approvePlan(p, { plan: "specs/coupons.plan.md", approve: ["TC-003"], words: "approve it anyway" }, undefined, TODAY);
  assert.deepEqual(a.data.approvedNow, []);
  assert.ok(a.need.some((n) => n.startsWith("**TC-003** can't be approved")));
});

test("approve_plan: when the plan changes a case after approval, the approval lapses and the approved plan follows", async () => {
  const p = project();
  await approvePlan(p, { plan: "specs/coupons.plan.md", approve: ["TC-001"], words: "yes" }, undefined, TODAY);
  const changed: TestPlan = structuredClone(COUPONS);
  changed.suites[0].tests[0].steps[2].expect = ["The total shows €10.80"];
  fs.writeFileSync(path.join(p.root, "specs/coupons.plan.md"), renderPlan(changed));
  const a = await approvePlan(p, { plan: "specs/coupons.plan.md" }, undefined, TODAY);
  assert.equal(a.data.cases[0].approval, undefined);
  assert.equal(exists(p, "specs/coupons.approved.md"), false);
  assert.ok(a.did.some((d) => d.includes("no case is approved any more")));
});

test("approve_plan: a missing, foreign or off-limits plan is refused plainly", async () => {
  const p = project(COUPONS, { ignore: ["specs/secret.plan.md"] });
  await assert.rejects(() => approvePlan(p, { plan: "specs/nope.plan.md" }), /There's no plan at specs\/nope\.plan\.md/);
  fs.writeFileSync(path.join(p.root, "specs/notes.md"), "# Notes\n");
  await assert.rejects(() => approvePlan(p, { plan: "specs/notes.md" }), /doesn't look like a plan saved by Playwright's planner/);
  fs.writeFileSync(path.join(p.root, "specs/secret.plan.md"), renderPlan(COUPONS));
  await assert.rejects(() => approvePlan(p, { plan: "specs/secret.plan.md" }), /off limits/);
  await assert.rejects(() => approvePlan(p, { plan: "../outside.plan.md" }), /outside the project/);
  await assert.rejects(() => approvePlan(p, { plan: "specs/coupons.plan.md", approve: ["TC-099"], words: "yes" }), /no test case TC-099/);
});

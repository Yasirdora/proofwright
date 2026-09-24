import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { approvedPlan, buildCases, type CaseLedger } from "../src/plan/cases.js";
import { parsePlan, PlanFormatError, renderPlan, type TestPlan } from "../src/plan/playwright-plan.js";
import { COUPONS } from "./fixtures.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

const ledger = (): CaseLedger => ({ plan: "specs/coupons.plan.md", ids: {}, approvals: {} });

test("contract: a plan saved by Playwright's own planner_save_plan reads back exactly — and we write it the same way", async () => {
  // Playwright's test MCP server, as its agents use it, in a scratch project.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-contract-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir");
  fs.writeFileSync(path.join(dir, "playwright.config.ts"), 'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "tests" });\n');
  const client = new Client({ name: "proofwright-contract", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [path.join(REPO, "node_modules/playwright/cli.js"), "run-test-mcp-server"], cwd: dir }),
  );
  try {
    const r = await client.callTool({
      name: "planner_save_plan",
      arguments: { ...COUPONS, name: COUPONS.name, fileName: "specs/coupons.plan.md" },
    });
    assert.ok(!(r as { isError?: boolean }).isError, JSON.stringify(r));
  } finally {
    await client.close();
  }
  const saved = fs.readFileSync(path.join(dir, "specs/coupons.plan.md"), "utf8");
  assert.deepEqual(parsePlan(saved), COUPONS, "reads Playwright's file exactly");
  assert.equal(renderPlan(COUPONS), saved, "writes byte-for-byte what Playwright writes");
});

test("plan: a file that isn't a Playwright plan is refused with a plain reason", () => {
  assert.throws(() => parsePlan("# Notes\n\nJust some notes.\n"), PlanFormatError);
  assert.throws(() => parsePlan("# Plan\n\n## Test Scenarios\n\n### 1. Suite\n"), /at least one "#### 1\.1\." test/);
});

test("cases: numbered, with the values typed as data, and what's open listed", () => {
  const cases = buildCases(COUPONS, ledger());
  assert.deepEqual(cases.map((c) => c.id), ["TC-001", "TC-002", "TC-003"]);
  const [valid, expired, clicks] = cases;
  assert.deepEqual(valid.steps[0].data, [], "a label clicked isn't test data");
  assert.deepEqual(valid.steps[2].data, ["SAVE10"], "a value typed is");
  assert.deepEqual(valid.blocking, []);
  assert.deepEqual(valid.questions, []);
  assert.deepEqual(expired.blocking, []);
  assert.ok(expired.questions.some((q) => q.includes("doesn't say which")), "typing a value it doesn't name");
  assert.ok(expired.questions.some((q) => q.includes('"It works as expected"')), "an expectation nothing can check");
  assert.deepEqual(clicks.blocking, ["it has no expected result anywhere, so it could never fail"]);
});

test("cases: numbers stay put when the plan changes; a changed case loses its approval", () => {
  const l = ledger();
  const first = buildCases(COUPONS, l);
  l.approvals["TC-001"] = { on: "2026-09-24", words: "yes", how: "asked you directly", fingerprint: first[0].fingerprint };
  l.approvals["TC-002"] = { on: "2026-09-24", words: "yes", how: "asked you directly", fingerprint: first[1].fingerprint };

  const replanned: TestPlan = structuredClone(COUPONS);
  const suite = replanned.suites[0];
  suite.tests.unshift({ name: "The coupon field starts empty", file: "demo/generated/coupons/empty.spec.ts", steps: [{ perform: "Open the cart", expect: ["The Coupon code field is empty"] }] });
  suite.tests[2].steps[1].expect = ['The page says "This coupon has expired"'];

  const second = buildCases(replanned, l);
  const byName = new Map(second.map((c) => [c.name, c]));
  assert.equal(byName.get("A valid coupon lowers the total")!.id, "TC-001");
  assert.equal(byName.get("An expired coupon is refused")!.id, "TC-002");
  assert.equal(byName.get("The coupon field starts empty")!.id, "TC-004", "a new case gets the next number");
  assert.ok(byName.get("A valid coupon lowers the total")!.approval, "unchanged: still approved");
  assert.equal(byName.get("An expired coupon is refused")!.approval, undefined, "changed: must be approved again");
});

test("cases: the approved plan holds only approved cases, titled with their numbers, in Playwright's format", () => {
  const l = ledger();
  const cases = buildCases(COUPONS, l);
  assert.equal(approvedPlan(COUPONS, cases), null, "nothing approved, nothing to generate");
  l.approvals["TC-001"] = { on: "2026-09-24", words: "go", how: "asked you directly", fingerprint: cases[0].fingerprint };
  const plan = approvedPlan(COUPONS, buildCases(COUPONS, l))!;
  assert.deepEqual(plan.suites.flatMap((s) => s.tests.map((t) => t.name)), ["TC-001 · A valid coupon lowers the total"]);
  assert.deepEqual(parsePlan(renderPlan(plan)), plan, "Playwright's generator reads it like any plan");
});

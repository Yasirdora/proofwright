import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { renderAnswer } from "../src/answer.js";
import { Project, ProjectError } from "../src/project.js";
import { classify } from "../src/runs/classify.js";
import { compare, type Run, type RunTest } from "../src/runs/runs.js";
import { explain, report } from "../src/runs/tools.js";
import { demoCopy, freePort } from "./fixtures.js";

/** What each failure really is — demo/answer-key/FAILURES.md. */
const KEY: Record<string, string> = {
  "SAVE10 on a notebook rounds to the nearest cent": "app bug",
  "a quantity of -1 is refused": "app bug",
  "adding to the cart updates the count": "test bug",
  "applying a coupon shows the discount": "test bug",
  "the cart total is read from the summary": "test bug",
  "retried › the header shows the shop's name": "flaky",
  "the stock service answers": "environment",
};

test("report runs Playwright's runner and names every failure the way the answer key does", async () => {
  const project = demoCopy(["demo/failures"]);
  process.env.SHOP_PORT = await freePort();
  try {
    const first = report(project, { run: { project: "failures" } });
    assert.equal(first.headline, "8 tests: 1 passed, 6 failed, 1 flaky.");
    const kinds = Object.fromEntries(first.data.diagnoses.map((d) => [d.title, d.diagnosis.kind]));
    assert.deepEqual(kinds, KEY);
    const certain = first.data.diagnoses.filter((d) => d.diagnosis.confidence === "certain").map((d) => d.title).sort();
    assert.deepEqual(certain, [
      "adding to the cart updates the count",
      "retried › the header shows the shop's name",
      "the cart total is read from the summary",
      "the stock service answers",
    ]);
    // The evidence is kept with the run, not left in test-results/ (which the next run clears).
    for (const t of first.data.run.tests.filter((x) => x.status === "failed")) {
      assert.ok(t.evidence.errorContext && fs.existsSync(path.join(project.root, t.evidence.errorContext)), t.title);
      assert.ok(t.evidence.screenshot?.startsWith("proofwright/runs/"), t.title);
    }
    assert.ok(fs.existsSync(path.join(project.root, first.data.reportFile)));

    const why = explain(project, { test: "applying a coupon" });
    assert.match(why.headline, /^Test bug \(likely\): the test looks for getByRole\('button', \{ name: 'Apply coupon' \}\); the page has button "Apply"\.$/);
    assert.match(why.found, /`getByRole\('button', \{ name: 'Apply' \}\)`/);
    assert.ok(why.did.includes("Nothing was changed."));

    const second = report(project, { run: { project: "failures" } });
    assert.match(second.headline, /— 0 new failures, 0 fixed since the last run\.$/);
    assert.equal(second.data.previous, first.data.run.id);
    assert.match(second.found, /Still failing: "SAVE10 on a notebook/);
  } finally {
    delete process.env.SHOP_PORT;
  }
});

test("report says when a test.only let only part of the selection run", async () => {
  const project = demoCopy(["demo/colleague"]);
  process.env.SHOP_PORT = await freePort();
  try {
    // demo/colleague/wip.spec.ts:3 is a test.only: Playwright runs it alone, and says nothing of the other 7.
    const r = report(project, { run: { project: "colleague" } });
    assert.deepEqual(r.data.run.focused, ["demo/colleague/wip.spec.ts:3"]);
    assert.equal(r.headline, "1 test: 1 passed, 0 failed, 0 flaky. Only the tests marked test.only ran.");
    assert.match(r.found, /^\*\*Only part of the selection ran\.\*\* .*\[demo\/colleague\/wip\.spec\.ts:3\]/);
    assert.match(r.need[0], /^Remove the `\.only` at `demo\/colleague\/wip\.spec\.ts:3`/);
    // Naming the other file leaves the .only out of the selection: the whole selection runs.
    const whole = report(project, { run: { paths: ["demo/colleague/checkout.spec.ts"], project: "colleague", grep: "sign up" } });
    assert.equal(whole.data.run.focused, undefined);
    assert.doesNotMatch(whole.headline, /test\.only/);
  } finally {
    delete process.env.SHOP_PORT;
  }
});

// ---------------------------------------------------------------- the rules, one by one

function failed(message: string, extra: Partial<RunTest> = {}): RunTest {
  return {
    id: "p:1",
    title: "a test",
    file: "tests/a.spec.ts",
    line: 3,
    project: "p",
    status: "failed",
    attempts: ["failed"],
    durationMs: 1,
    error: { message, file: "tests/a.spec.ts", line: 5 },
    evidence: {},
    ...extra,
  };
}

const PAGE = `- main [ref=e1]:
  - heading "Your cart" [level=1] [ref=e2]
  - textbox "Coupon code" [ref=e3]
  - button "Apply" [ref=e4] [cursor=pointer]
  - button "Remove Blue mug" [ref=e5]`;

test("classify: a locator that finds nothing — a similar element is a test bug; none at all, an app bug", () => {
  const miss = (loc: string) => failed(`TimeoutError: locator.click: Timeout 2000ms exceeded.\nCall log:\n  - waiting for ${loc}\n`);
  assert.equal(classify(miss("getByRole('button', { name: 'Apply coupon' })"), { snapshot: PAGE }).kind, "test bug");
  const none = classify(miss("getByRole('button', { name: 'Checkout' })"), { snapshot: PAGE });
  assert.equal(none.kind, "app bug");
  assert.equal(none.confidence, "possible");
  assert.match(none.reasoning.join(" "), /The page at that moment showed "Your cart"/);
  // A textbox sharing a word isn't "similar" to a button.
  assert.equal(classify(miss("getByRole('button', { name: 'Coupon wizard' })"), { snapshot: PAGE }).kind, "app bug");
  // Exactly the element, yet unusable: hidden, covered or disabled — unclear.
  assert.equal(classify(miss("getByRole('button', { name: 'Apply' })"), { snapshot: PAGE }).kind, "unclear");
  // No snapshot: say so, don't guess.
  assert.equal(classify(miss("getByRole('button', { name: 'Apply coupon' })"), {}).kind, "unclear");
});

test("classify: a value mismatch is an app bug — likely when an approved case set the expectation", () => {
  const msg = `Error: expect(locator).toHaveText(expected) failed\n\nLocator:  getByTestId('total')\nExpected: "€10.80"\nReceived: "€9.60"\nTimeout:  5000ms\n\nCall log:\n    - locator resolved to <dd>€9.60</dd>\n`;
  const plain = classify(failed(msg));
  assert.deepEqual([plain.kind, plain.confidence, plain.expected, plain.received], ["app bug", "possible", '"€10.80"', '"€9.60"']);
  assert.equal(classify(failed(msg), { approvedCase: true }).confidence, "likely");
  assert.doesNotMatch(classify(failed(msg)).proposal, /change the test's expectation to match/i);
  // It passed before on the same code: it may be flaky, so it's only "possible".
  const flakyHint = classify(failed(msg), { approvedCase: true, head: "abc", history: [{ status: "passed", head: "abc" }] });
  assert.equal(flakyHint.confidence, "possible");
  assert.match(flakyHint.reasoning.join(" "), /may be flaky/);
});

test("classify: environment, code errors, strict mode, flaky and timeouts", () => {
  assert.equal(classify(failed("Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4610/")).kind, "environment");
  assert.equal(classify(failed("Error: browserType.launch: Executable doesn't exist at /x/chrome")).kind, "environment");
  assert.equal(classify(failed("ReferenceError: total is not defined")).kind, "test bug");
  const strict = classify(
    failed("Error: locator.click: Error: strict mode violation: getByRole('button') resolved to 2 elements:\n    1) <button>A</button> aka getByRole('button', { name: 'A' })\n    2) <button>B</button> aka getByRole('button', { name: 'B' })\n"),
  );
  assert.equal(strict.kind, "test bug");
  assert.match(strict.proposal, /getByRole\('button', \{ name: 'A' \}\)/);
  assert.equal(classify(failed("Error: nope", { status: "flaky", attempts: ["failed", "passed"] })).kind, "flaky");
  const timeout = "Test timeout of 30000ms exceeded.";
  assert.equal(classify(failed(timeout)).kind, "unclear");
  assert.equal(classify(failed(timeout), { head: "h", history: [{ status: "passed", head: "h" }] }).kind, "flaky");
});

// ---------------------------------------------------------------- comparison and imported reports

test("compare: new failures, still failing, fixed and new tests — over the tests both runs ran", () => {
  const t = (id: string, status: RunTest["status"]) => failed("", { id, status });
  const run = (tests: RunTest[]): Run => ({ id: "r", startedAt: "", durationMs: 0, source: { imported: "x" }, errors: [], tests });
  const c = compare(run([t("a", "passed"), t("b", "failed"), t("c", "failed")]), run([t("a", "failed"), t("b", "failed"), t("c", "passed"), t("d", "failed")]));
  assert.deepEqual([c.newFailures, c.stillFailing, c.fixed, c.newTests].map((xs) => xs.map((x) => x.id)), [["a"], ["b"], ["c"], ["d"]]);
  assert.deepEqual(compare(undefined, run([t("a", "failed")])).newTests, [], "no previous run: nothing is 'new'");
});

/** A Playwright JSON report, as CI would leave it. */
function ciReport(title: string, message: string) {
  return {
    config: { rootDir: "" },
    stats: { startTime: "2026-09-24T08:00:00.000Z", duration: 1200 },
    errors: [],
    suites: [
      {
        title: "tests/coupons.spec.ts",
        file: "tests/coupons.spec.ts",
        specs: [
          {
            id: "abc-def",
            title,
            file: "tests/coupons.spec.ts",
            line: 4,
            tests: [{ projectName: "chromium", status: "unexpected", results: [{ status: "failed", retry: 0, duration: 1200, error: { message } }] }],
          },
        ],
      },
    ],
  };
}

test("report from a CI JSON report; explain ties an approved case's failure to its case", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-ci-"));
  fs.mkdirSync(path.join(dir, "proofwright/cases"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "proofwright/cases/coupons.json"),
    JSON.stringify({ plan: "specs/coupons.plan.md", ids: {}, approvals: { "TC-001": { on: "2026-09-24", words: "yes", how: "asked you directly", fingerprint: "x" } } }),
  );
  fs.writeFileSync(path.join(dir, "proofwright/cases/coupons.md"), "## TC-001 · A valid coupon lowers the total\n");
  const msg = `Error: expect(locator).toHaveText(expected) failed\n\nLocator:  getByTestId('total')\nExpected: "€10.80"\nReceived: "€9.60"\n\nCall log:\n    - locator resolved to <dd>€9.60</dd>\n`;
  fs.writeFileSync(path.join(dir, "ci-report.json"), JSON.stringify(ciReport("TC-001 · A valid coupon lowers the total", msg)));
  const project = new Project(dir);

  const r = report(project, { from: "ci-report.json" });
  assert.equal(r.headline, "1 test: 0 passed, 1 failed, 0 flaky.");
  assert.ok(r.did[0].startsWith("Read Playwright's JSON report `ci-report.json`"));
  assert.match(r.found, /\*\*Test cases:\*\* TC-001 failed/);

  const e = explain(project, { test: "TC-001" });
  assert.equal(e.data.diagnosis.kind, "app bug");
  assert.equal(e.data.diagnosis.confidence, "likely");
  assert.match(e.data.bugDraft ?? "", /Steps: see TC-001 in `proofwright\/cases\/coupons\.md`\./);
  assert.match(renderAnswer(e), /### What I need from you\n1\. File the bug/);

  assert.throws(() => report(project, { from: "nope.json" }), ProjectError);
  fs.writeFileSync(path.join(dir, "junk.json"), "{}");
  assert.throws(() => report(project, { from: "junk.json" }), /isn't a Playwright JSON report/);
  assert.throws(() => report(project, { from: "ci-report.json", run: true }), /Either run the tests or read a report/);
  assert.throws(() => explain(project, { test: "nothing like this" }), /No failure matching/);
});

test("report with nothing recorded says what to do", () => {
  const project = new Project(fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-empty-")));
  assert.throws(() => report(project, {}), /no recorded run yet/);
});

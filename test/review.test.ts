import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderAnswer } from "../src/answer.js";
import { Project, ProjectError } from "../src/project.js";
import { review } from "../src/review/review.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** The colleague's files, exactly as demo/answer-key/REVIEW.md lists them. */
const EXPECTED: Array<[string, string, number[]]> = [
  ["demo/colleague/checkout.spec.ts", "shared-state", [5]],
  ["demo/colleague/checkout.spec.ts", "serial-mode", [7]],
  ["demo/colleague/checkout.spec.ts", "no-assertion", [9]],
  ["demo/colleague/checkout.spec.ts", "fragile-selector", [11, 12, 13, 14, 15, 16]],
  ["demo/colleague/checkout.spec.ts", "secret-in-test", [13, 14]],
  ["demo/colleague/checkout.spec.ts", "fixed-wait", [17]],
  ["demo/colleague/checkout.spec.ts", "no-assertion", [20]],
  ["demo/colleague/checkout.spec.ts", "fragile-selector", [22]],
  ["demo/colleague/checkout.spec.ts", "forced-action", [30]],
  ["demo/colleague/checkout.spec.ts", "fragile-selector", [31]],
  ["demo/colleague/checkout.spec.ts", "shared-account", [36]],
  ["demo/colleague/checkout.spec.ts", "secret-in-test", [37]],
  ["demo/colleague/checkout.spec.ts", "fixed-wait", [39]],
  ["demo/colleague/checkout.spec.ts", "unawaited-expect", [46]],
  ["demo/colleague/checkout.spec.ts", "shared-state", [50]],
  ["demo/colleague/checkout.spec.ts", "retries", [55]],
  ["demo/colleague/checkout.spec.ts", "fragile-selector", [59]],
  ["demo/colleague/wip.spec.ts", "focused-test", [3]],
  ["demo/colleague/wip.spec.ts", "skipped-test", [8]],
];

const summarize = (findings: Array<{ file: string; rule: string; lines: number[] }>) =>
  findings.map((f) => [f.file, f.rule, f.lines] as [string, string, number[]]);

test("review: the colleague's files give exactly the findings in the review key", () => {
  const answer = review(new Project(REPO), ["demo/colleague"]);
  assert.deepEqual(summarize(answer.data.findings), EXPECTED);
  assert.deepEqual(answer.data.counts, { high: 8, medium: 11, low: 0 });
});

test("review: every line REVIEW.md cites is covered by a finding", () => {
  // Keeps the written key and the tool from drifting apart: each row's
  // references — single lines or ranges; "(with :n)" is context — must hold a finding.
  const key = fs.readFileSync(path.join(REPO, "demo/answer-key/REVIEW.md"), "utf8");
  const section = key.split("## Review findings")[1].split("\n## ")[0];
  const findings = review(new Project(REPO), ["demo/colleague"]).data.findings;
  let checked = 0;
  for (const row of section.split("\n").filter((l) => l.startsWith("| ") && l.includes(".spec.ts"))) {
    const cell = row.split("|")[2].replace(/\([^)]*\)/g, "");
    let file = "";
    for (const part of cell.split(/[,;]/)) {
      const m = /`(?:(\w+\.spec\.ts))?:(\d+)`(?:\s*–\s*`:(\d+)`)?/.exec(part);
      if (!m) continue;
      if (m[1]) file = `demo/colleague/${m[1]}`;
      const from = Number(m[2]);
      const to = m[3] ? Number(m[3]) : from;
      const hit = findings.some((f) => f.file === file && f.lines.some((l) => l >= from && l <= to));
      assert.ok(hit, `REVIEW.md cites ${file}:${from}${to !== from ? `–${to}` : ""} but no finding covers it`);
      checked++;
    }
  }
  assert.ok(checked >= 15, `parsed ${checked} references from REVIEW.md`);
});

test("review: the shop's own tests are clean", () => {
  const answer = review(new Project(REPO), ["demo/tests"]);
  assert.equal(answer.data.files.length, 1);
  assert.deepEqual(answer.data.findings, []);
  assert.equal(answer.headline, "1 test file reviewed — no problems found.");
});

test("review: the answer key is never read — it's left out and says so", () => {
  const answer = review(new Project(REPO), ["demo"]);
  assert.deepEqual(answer.data.ignored, ["demo/answer-key"]);
  assert.ok(!answer.data.files.some((f) => f.startsWith("demo/answer-key")));
  assert.ok(answer.did.some((d) => d.includes("`demo/answer-key`") && d.includes("off limits")));
});

test("review: the answer has the three parts, with clickable file:line", () => {
  const text = renderAnswer(review(new Project(REPO), ["demo/colleague/wip.spec.ts"]));
  for (const heading of ["### What I did", "### What I found", "### What I need from you"]) {
    assert.ok(text.includes(heading), heading);
  }
  assert.ok(text.includes("[demo/colleague/wip.spec.ts:3](demo/colleague/wip.spec.ts:3)"));
  assert.ok(text.includes("Nothing was run and nothing was changed."));
});

test("review: a path outside the project is refused", () => {
  assert.throws(() => review(new Project(REPO), ["../"]), ProjectError);
});

// ---------------------------------------------------------------- rule edges, on small fixtures

function fixture(files: Record<string, string>): Project {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-review-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return new Project(dir);
}

const lineOf = (text: string, needle: string) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

test("rule: a helper that asserts counts as an assertion; one that doesn't, doesn't", () => {
  const spec = `import { test } from "@playwright/test";
import { seesWelcome } from "./helpers";

test("uses a helper that asserts", async ({ page }) => {
  await seesWelcome(page);
});

test("uses a helper that only navigates", async ({ page }) => {
  await goHome(page);
});

async function goHome(page) {
  await page.goto("/");
}
`;
  const project = fixture({
    "tests/helpers.ts": `import { expect } from "@playwright/test";
export async function seesWelcome(page) {
  await expect(page.getByText("Welcome")).toBeVisible();
}
`,
    "tests/a.spec.ts": spec,
  });
  const f = review(project, ["tests"]).data.findings;
  assert.deepEqual(summarize(f), [["tests/a.spec.ts", "no-assertion", [lineOf(spec, "only navigates")]]]);
});

test("rule: awaited, returned or handed-on expects are fine; bare async ones are flagged", () => {
  const spec = `import { test, expect } from "@playwright/test";

test("await forms", async ({ page }) => {
  await expect(page.getByText("a")).toBeVisible();
  await Promise.all([expect(page.getByText("b")).toBeVisible()]);
  const pending = expect(page.getByText("c")).toBeVisible();
  await pending;
  expect(1 + 1).toBe(2);
  expect(page.getByText("d")).not.toBeVisible();
  expect.soft(page.getByText("e")).toHaveText("e");
});

test("returns it", ({ page }) => expect(page).toHaveTitle("Shop"));
`;
  const f = review(fixture({ "a.spec.ts": spec }), ["."]).data.findings;
  assert.deepEqual(summarize(f), [
    ["a.spec.ts", "unawaited-expect", [lineOf(spec, '"d"')]],
    ["a.spec.ts", "unawaited-expect", [lineOf(spec, '"e"')]],
  ]);
});

test("rule: a conditional skip with a reason is fine; skips left in, .fixme and .only are flagged", () => {
  const spec = `import { test, expect } from "@playwright/test";

test("runtime skips", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "Safari has no clipboard API");
  test.skip();
  await expect(page).toHaveTitle("Shop");
});

// Tracked in ISSUE-12: the export page is being rebuilt.
test.skip("documented skip", async () => {});

test.fixme("undocumented fixme", async () => {});

test.describe.only("focused block", () => {});
`;
  const f = review(fixture({ "a.spec.ts": spec }), ["."]).data.findings;
  assert.deepEqual(summarize(f), [
    ["a.spec.ts", "skipped-test", [lineOf(spec, "test.skip();")]],
    ["a.spec.ts", "skipped-test", [lineOf(spec, "documented skip")]],
    ["a.spec.ts", "skipped-test", [lineOf(spec, "undocumented fixme")]],
    ["a.spec.ts", "focused-test", [lineOf(spec, "focused block")]],
  ]);
  const sources = f.map((x) => x.source);
  assert.deepEqual(sources, [
    "eslint-plugin-playwright/no-skipped-test",
    "eslint-plugin-playwright/no-skipped-test",
    "proofwright",
    "eslint-plugin-playwright/no-focused-test",
  ]);
});

test("rule: raw locators and nth()/first() are fragile, grouped per test; user-facing locators aren't", () => {
  const spec = `import { test, expect } from "@playwright/test";

test("selectors", async ({ page }) => {
  await expect(page.locator("//div[2]/span")).toBeVisible();
  await expect(page.locator("li")).toHaveCount(3);
  await expect(page.getByRole("listitem").nth(2)).toBeVisible();
  // The third row is the newest order.
  await expect(page.getByRole("row").nth(2)).toContainText("PW-");
  await expect(page.locator("form input[name='q']")).toBeVisible();
});
`;
  const f = review(fixture({ "a.spec.ts": spec }), ["."]).data.findings;
  assert.deepEqual(summarize(f), [
    [
      "a.spec.ts",
      "fragile-selector",
      [
        lineOf(spec, "//div"),
        lineOf(spec, 'locator("li")'),
        lineOf(spec, 'getByRole("listitem")'),
        lineOf(spec, 'getByRole("row")'),
        lineOf(spec, "form input"),
      ],
    ],
  ]);
  const clean = `import { test, expect } from "@playwright/test";
test("user-facing locators", async ({ page }) => {
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByLabel("Coupon code")).toBeEmpty();
  await expect(page.getByTestId("total")).toHaveText("€10.80");
});
`;
  assert.deepEqual(review(fixture({ "b.spec.ts": clean }), ["."]).data.findings, []);
});

test("rule: secrets and real-looking personal data", () => {
  const spec = `import { test, expect } from "@playwright/test";

test("secrets", async ({ page, request }) => {
  await request.post("/api/login", { data: { email: "qa@example.com", password: "hunter22" } });
  await page.getByLabel("Email").fill("jane.doe@gmail.com");
  await page.getByLabel("API key").fill("sk-test-123");
  await page.getByLabel("Password").fill(process.env.SHOP_PASSWORD ?? "");
  await expect(page).toHaveTitle("Shop");
});
`;
  const f = review(fixture({ "a.spec.ts": spec }), ["."]).data.findings;
  assert.deepEqual(summarize(f), [
    ["a.spec.ts", "secret-in-test", [lineOf(spec, "hunter22"), lineOf(spec, "API key")]],
    ["a.spec.ts", "personal-data", [lineOf(spec, "gmail")]],
  ]);
});

test("rule: retries: 0 is not a finding", () => {
  const spec = `import { test, expect } from "@playwright/test";
test.describe.configure({ retries: 0 });
test("fine", async ({ page }) => {
  await expect(page).toHaveTitle("Shop");
});
`;
  assert.deepEqual(review(fixture({ "a.spec.ts": spec }), ["."]).data.findings, []);
});

test("review: an empty folder says so, and is not an error", () => {
  const answer = review(fixture({ "notes.md": "# notes\n" }), ["."]);
  assert.equal(answer.headline, "No test files found there.");
});

test("review: every finding names who found it — the plugin or Proofwright", () => {
  const f = review(new Project(REPO), ["demo/colleague"]).data.findings;
  const bySource = (s: string) => f.filter((x) => x.source.split(", ").some((y) => y.startsWith(s))).map((x) => x.rule);
  assert.deepEqual(
    [...new Set(bySource("eslint-plugin-playwright/"))].sort(),
    ["fixed-wait", "focused-test", "forced-action", "fragile-selector", "no-assertion", "skipped-test", "unawaited-expect"],
  );
  assert.deepEqual(
    [...new Set(bySource("proofwright"))].sort(),
    ["fragile-selector", "retries", "secret-in-test", "serial-mode", "shared-account", "shared-state"],
  );
  const text = renderAnswer(review(new Project(REPO), ["demo/colleague/wip.spec.ts"]));
  assert.ok(text.includes("*Found by:* eslint-plugin-playwright `no-focused-test`"), text);
});

test("review: the tester's own ESLint config is never read", () => {
  const spec = `import { test } from "@playwright/test";
test("no assertion", async ({ page }) => {
  await page.goto("/");
});
`;
  // A config that would switch every rule off — or break ESLint — if it were loaded.
  const project = fixture({
    "a.spec.ts": spec,
    "eslint.config.js": "throw new Error('this config must not be loaded');\n",
  });
  assert.deepEqual(summarize(review(project, ["."]).data.findings), [["a.spec.ts", "no-assertion", [2]]]);
});

test("review: a file the plugin can't parse is named, and Proofwright's own checks still run on it", () => {
  const spec = `import { test } from "@playwright/test";
let shared;
test("writes", async () => { shared = 1; });
test("broken", async () => { const = ; });
`;
  const answer = review(fixture({ "a.spec.ts": spec }), ["."]);
  assert.equal(answer.data.unreadable.length, 1);
  assert.equal(answer.data.unreadable[0].file, "a.spec.ts");
  assert.ok(answer.data.findings.some((x) => x.rule === "shared-state"));
  assert.ok(answer.did.some((d) => d.includes("Couldn't parse `a.spec.ts`")));
});

test("review: test files that don't use Playwright are left out, and named", () => {
  const project = fixture({
    "tests/fixtures.ts": `import { test as base } from "@playwright/test";\nexport const test = base;\nexport { expect } from "@playwright/test";\n`,
    "tests/shop.spec.ts": `import { test, expect } from "./fixtures";\ntest("t", async ({ page }) => {\n  await page.goto("/");\n});\n`,
    "unit/sum.test.ts": `import test from "node:test";\nimport assert from "node:assert";\ntest("adds", () => assert.equal(1 + 1, 2));\n`,
    "unit/cart.test.js": `import { describe, it, expect } from "vitest";\ndescribe("cart", () => it("is empty", () => expect([]).toEqual([])));\n`,
  });
  const answer = review(project, ["."]);
  assert.deepEqual(answer.data.files, ["tests/shop.spec.ts"], "a spec using Playwright through a fixtures file counts");
  assert.deepEqual(answer.data.notPlaywright, ["unit/cart.test.js", "unit/sum.test.ts"]);
  assert.deepEqual(summarize(answer.data.findings), [["tests/shop.spec.ts", "no-assertion", [2]]]);
  assert.ok(answer.did.some((d) => d.includes("2 test files that don't use Playwright")));
});

test("review: the whole repository — Proofwright's own unit tests aren't Playwright tests", () => {
  const answer = review(new Project(REPO), []);
  assert.ok(answer.data.notPlaywright.every((f) => f.startsWith("test/")));
  assert.ok(answer.data.notPlaywright.length >= 4);
  assert.ok(!answer.data.findings.some((f) => f.file.startsWith("test/")));
  assert.equal(answer.data.findings.length, 19, "only the colleague's files have problems");
});

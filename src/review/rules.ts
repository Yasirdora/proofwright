/**
 * The review rules (spec §5), as data: what each one means for a tester, why it
 * matters, what to do instead, and who checks it. Rules that
 * eslint-plugin-playwright already has are checked by it (eslint.ts); the rest
 * are Proofwright's own (check.ts). No AI opinion — the same file always gets
 * the same findings.
 */
export type Severity = "high" | "medium" | "low";

export type RuleId =
  | "fixed-wait"
  | "no-assertion"
  | "unawaited-expect"
  | "forced-action"
  | "fragile-selector"
  | "focused-test"
  | "skipped-test"
  | "shared-state"
  | "serial-mode"
  | "shared-account"
  | "secret-in-test"
  | "personal-data"
  | "retries";

export interface Rule {
  id: RuleId;
  severity: Severity;
  title: string;
  why: string;
  fix: string;
  /** Who checks it. */
  checkedBy: string;
}

const rules: Rule[] = [
  {
    id: "no-assertion",
    severity: "high",
    title: "A test with no assertion",
    why: "It passes as long as nothing throws, so it can't tell a working feature from a broken one.",
    fix: "Check the outcome the test is about, e.g. `await expect(page.getByRole(\"status\")).toHaveText(\"Blue mug added to your cart.\")`.",
    checkedBy: "eslint-plugin-playwright `expect-expect` (with the helpers that assert)",
  },
  {
    id: "unawaited-expect",
    severity: "high",
    title: "An `expect` that is never awaited",
    why: "Playwright's page and locator assertions wait and retry; without `await` the test moves on and the check never decides anything.",
    fix: "Put `await` in front of it.",
    checkedBy: "eslint-plugin-playwright `missing-playwright-await`",
  },
  {
    id: "focused-test",
    severity: "high",
    title: "`.only` left in",
    why: "Every run of this project now runs only the focused tests; the rest are silently left out.",
    fix: "Remove `.only`. (Setting `forbidOnly` in playwright.config makes CI refuse it.)",
    checkedBy: "eslint-plugin-playwright `no-focused-test`",
  },
  {
    id: "shared-state",
    severity: "high",
    title: "Tests that pass data to each other",
    why: "A test that reads a value another test wrote fails when run alone, in another order, or in parallel — and its failure points at the wrong test.",
    fix: "Make each test create what it needs (an API call, a fixture, or `beforeEach`).",
    checkedBy: "Proofwright",
  },
  {
    id: "secret-in-test",
    severity: "high",
    title: "A password or token written into the test",
    why: "Credentials in test code end up in the repository and its history; and a fixed password couples tests to one account.",
    fix: "Generate a password per run for new accounts, and read real credentials from environment variables or Playwright's saved sign-in state.",
    checkedBy: "Proofwright",
  },
  {
    id: "fixed-wait",
    severity: "medium",
    title: "A fixed wait",
    why: "It waits for time, not for the thing you need: too long makes the suite slow, too short makes it flaky.",
    fix: "Wait for the state instead — Playwright's actions and web-first assertions already wait, e.g. `await expect(page.getByRole(\"heading\", { name: \"Checkout\" })).toBeVisible()`.",
    checkedBy: "eslint-plugin-playwright `no-wait-for-timeout`",
  },
  {
    id: "forced-action",
    severity: "medium",
    title: "A forced action",
    why: "`force: true` skips the checks a real user would hit (hidden, covered, disabled), so the test can pass where a user is stuck.",
    fix: "Remove `force: true` and fix what blocks the element — or assert on it, if being blocked is the bug.",
    checkedBy: "eslint-plugin-playwright `no-force-option`",
  },
  {
    id: "fragile-selector",
    severity: "medium",
    title: "A fragile selector",
    why: "Selectors tied to page structure, CSS or position break when the layout changes, even though nothing a user sees has changed.",
    fix: "Use what a user sees: `page.getByRole(…)`, `page.getByLabel(…)`, `page.getByText(…)` — or `getByTestId` when there's nothing else.",
    checkedBy: "eslint-plugin-playwright `no-raw-locators` and `no-nth-methods`; Proofwright for the selector-string page API",
  },
  {
    id: "skipped-test",
    severity: "medium",
    title: "A skipped test left in",
    why: "A switched-off test checks nothing, and nobody knows when to turn it back on, so it stays off.",
    fix: "Skip only on a condition, with the reason — `test.skip(browserName === \"webkit\", \"why\")` — or fix the test, or delete it.",
    checkedBy: "eslint-plugin-playwright `no-skipped-test`; Proofwright for `.fixme`",
  },
  {
    id: "serial-mode",
    severity: "medium",
    title: "Tests forced to run in order",
    why: "Serial mode is usually there to make tests that depend on each other pass; one failure then skips all the tests after it.",
    fix: "Make the tests independent, then remove `mode: \"serial\"`.",
    checkedBy: "Proofwright",
  },
  {
    id: "shared-account",
    severity: "medium",
    title: "Tests that share one account",
    why: "A test that logs in with an account another test created only works if that test ran first, and ran cleanly.",
    fix: "Create the account inside the test (or in a fixture), with a generated email and password.",
    checkedBy: "Proofwright",
  },
  {
    id: "personal-data",
    severity: "medium",
    title: "Real-looking personal data",
    why: "An address on a real domain may belong to a real person; tests can email it, and it ends up in reports and history.",
    fix: "Use a reserved domain — `example.com`, `example.org`, or `*.test` — for made-up addresses.",
    checkedBy: "Proofwright",
  },
  {
    id: "retries",
    severity: "medium",
    title: "Retries that can hide a flaky test",
    why: "With retries, a test that fails on its first try still reports as passed, so a real timing problem — in the test or the app — goes unseen.",
    fix: "Find why it fails the first time. If retries stay, keep an eye on the tests reported as flaky.",
    checkedBy: "Proofwright",
  },
];

export const RULES: Record<RuleId, Rule> = Object.fromEntries(rules.map((r) => [r.id, r])) as Record<RuleId, Rule>;

export const SEVERITY_ORDER: Severity[] = ["high", "medium", "low"];

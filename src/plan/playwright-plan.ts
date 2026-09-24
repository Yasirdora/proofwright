/**
 * Playwright's test plan — the Markdown its planner agent saves with
 * `planner_save_plan` — read into a structure, and written back in exactly the
 * same format, so the plan Proofwright hands to Playwright's generator is one
 * the generator already knows how to read.
 *
 * The format (playwright/lib/mcp/test/plannerTools.js, Playwright 1.61):
 *
 *   # <name>
 *   ## Application Overview
 *   <overview>
 *   ## Test Scenarios
 *   ### 1. <suite>
 *   **Seed:** `<seed file>`
 *   #### 1.1. <test>
 *   **File:** `<test file>`
 *   **Steps:**
 *     1. <action, or "-">
 *       - expect: <expected result>
 *
 * test/plan.test.ts checks this reader against files Playwright's own server
 * writes, so a change in a Playwright release shows up as a failing test.
 */

export interface PlanStep {
  /** The action, or undefined when the planner wrote "-". */
  perform?: string;
  expect: string[];
}

export interface PlanTest {
  name: string;
  file: string;
  steps: PlanStep[];
}

export interface PlanSuite {
  name: string;
  seedFile: string;
  tests: PlanTest[];
}

export interface TestPlan {
  name: string;
  overview: string;
  suites: PlanSuite[];
}

export class PlanFormatError extends Error {}

export function parsePlan(markdown: string): TestPlan {
  const lines = markdown.split(/\r?\n/);
  let name = "";
  const overview: string[] = [];
  const suites: PlanSuite[] = [];
  let section: "none" | "overview" | "scenarios" = "none";
  let suite: PlanSuite | undefined;
  let test: PlanTest | undefined;
  let inSteps = false;

  lines.forEach((line, i) => {
    const where = `line ${i + 1}`;
    let m: RegExpExecArray | null;
    if (!name && (m = /^#\s+(.+?)\s*$/.exec(line))) {
      name = m[1];
    } else if (/^##\s+Application Overview\s*$/.test(line)) {
      section = "overview";
    } else if (/^##\s+Test Scenarios\s*$/.test(line)) {
      section = "scenarios";
    } else if (section === "overview") {
      overview.push(line);
    } else if (section === "scenarios" && (m = /^###\s+\d+\.\s+(.+?)\s*$/.exec(line))) {
      suite = { name: m[1], seedFile: "", tests: [] };
      suites.push(suite);
      test = undefined;
      inSteps = false;
    } else if (suite && !test && (m = /^\*\*Seed:\*\*\s*`([^`]*)`/.exec(line))) {
      suite.seedFile = m[1];
    } else if (suite && (m = /^####\s+\d+\.\d+\.?\s+(.+?)\s*$/.exec(line))) {
      test = { name: m[1], file: "", steps: [] };
      suite.tests.push(test);
      inSteps = false;
    } else if (test && (m = /^\*\*File:\*\*\s*`([^`]*)`/.exec(line))) {
      test.file = m[1];
    } else if (test && /^\*\*Steps:\*\*\s*$/.test(line)) {
      inSteps = true;
    } else if (test && inSteps && (m = /^\s*-\s*expect:\s*(.*?)\s*$/.exec(line))) {
      const step = test.steps[test.steps.length - 1];
      if (!step) throw new PlanFormatError(`${where}: an expected result comes before any step.`);
      step.expect.push(m[1]);
    } else if (test && inSteps && (m = /^\s*\d+\.\s+(.*?)\s*$/.exec(line))) {
      test.steps.push({ ...(m[1] === "-" ? {} : { perform: m[1] }), expect: [] });
    }
  });

  if (!name || suites.length === 0 || suites.every((s) => s.tests.length === 0)) {
    throw new PlanFormatError(
      "This doesn't look like a plan saved by Playwright's planner: it needs a title, a \"## Test Scenarios\" section, and at least one \"#### 1.1.\" test.",
    );
  }
  return { name, overview: overview.join("\n").trim(), suites };
}

/** The plan as Playwright's planner would save it. */
export function renderPlan(plan: TestPlan): string {
  const lines: string[] = [`# ${plan.name}`, "", "## Application Overview", "", plan.overview, "", "## Test Scenarios"];
  plan.suites.forEach((suite, i) => {
    lines.push("", `### ${i + 1}. ${suite.name}`, "", `**Seed:** \`${suite.seedFile}\``);
    suite.tests.forEach((test, j) => {
      lines.push("", `#### ${i + 1}.${j + 1}. ${test.name}`, "", `**File:** \`${test.file}\``, "", "**Steps:**");
      test.steps.forEach((step, k) => {
        lines.push(`  ${k + 1}. ${step.perform ?? "-"}`);
        for (const e of step.expect) lines.push(`    - expect: ${e}`);
      });
    });
  });
  lines.push("");
  return lines.join("\n");
}

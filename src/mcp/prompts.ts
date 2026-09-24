/**
 * The `proofwright` prompt: the guided session in one plain sentence. It asks
 * the AI client to run Playwright's own agents and Proofwright's tools in
 * turn — the planner explores and drafts, the tester approves the test cases,
 * the generator writes only what was approved, and review checks it — with the
 * tester in charge at every step. Clients that support MCP prompts show it as
 * a slash command (in Claude Code: /mcp__proofwright__proofwright).
 */
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { type Project, ProjectError } from "../project.js";

export const PROMPTS = [
  {
    name: "proofwright",
    description:
      "Test something from one plain sentence: Playwright's planner drafts, you approve the test cases, Playwright's generator writes only the approved ones, and Proofwright reviews them.",
    arguments: [
      { name: "request", description: "What to test, in your own words, e.g. \"check that coupon codes work at checkout\".", required: true },
    ],
  },
];

/** "check that coupon codes work at checkout" → "coupon-codes-work-checkout". */
export function slugFor(request: string): string {
  const skip = new Set(["a", "an", "the", "that", "to", "at", "on", "in", "of", "and", "or", "for", "with", "check", "test", "make", "sure", "if", "is", "are", "it", "its", "please"]);
  const words = request
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w && !skip.has(w));
  return words.slice(0, 6).join("-") || "plan";
}

export function renderPrompt(name: string, args: Record<string, string>, project?: Project): GetPromptResult {
  if (name !== "proofwright") throw new ProjectError(`There is no prompt called "${name}".`);
  const request = (args.request ?? "").trim();
  if (!request) throw new ProjectError("Say what to test, e.g. \"check that coupon codes work at checkout\".");
  const slug = slugFor(request);
  const plan = `specs/${slug}.plan.md`;
  const setup = [
    ...(project?.config.project ? [`project "${project.config.project}"`] : []),
    ...(project?.config.seed ? [`seed file "${project.config.seed}"`] : []),
  ];
  const where = [
    ...(setup.length > 0 ? [`Set the page up (planner_setup_page, and later generator_setup_page) with ${setup.join(" and ")}.`] : []),
    ...(project?.config.testsDir ? [`Put each test's file under \`${project.config.testsDir}/\`.`] : []),
  ].join(" ");
  const text = `The tester asked: "${request}"

Run Proofwright's guided session. The tester is in charge: show them each Proofwright answer as it is, stop wherever it says "What I need from you", and never answer those questions or approve anything on their behalf.

1. Plan — with the playwright-test-planner agent. Explore the app for this request, then save the plan with planner_save_plan as \`${plan}\`. Cover the normal path, edge cases (limits, empty and unusual values) and errors; assume a fresh state for every test; give every step an expected result the page can show.${where ? ` ${where}` : ""}

2. Test cases — call Proofwright's approve_plan with plan "${plan}" and request "${request}". Show the tester the cases and the open questions. If they want changes, change the plan and call approve_plan again.

3. Approval — only when the tester says which cases they approve, call approve_plan again with those case numbers (or ["all"]) and their exact words in \`words\`. Proofwright may ask them directly instead. Nothing goes further without their yes.

4. Tests — with the playwright-test-generator agent, write one test per case in the approved plan approve_plan names (\`specs/${slug}.approved.md\`). Keep each test's title exactly as the plan has it — it starts with the case number.

5. Review — call Proofwright's review on the files the generator wrote, and show the findings.

Never use the playwright-test-healer agent, and never change what a test expects without the tester's yes. If test data is needed, Proofwright's test_data makes it up — made-up values only.`;
  return {
    description: `Proofwright: ${request}`,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

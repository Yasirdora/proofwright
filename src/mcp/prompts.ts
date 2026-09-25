/**
 * The `proofwright` prompt: the guided session in one plain sentence. It asks
 * the AI client to run Playwright's own agents and Proofwright's tools in
 * turn — the planner explores and drafts, the tester approves the test cases,
 * the generator writes only what was approved, review checks it, and prove
 * shows whether it can fail — with the tester in charge at every step. Clients that support MCP prompts show it as
 * a slash command (in Claude Code: /mcp__proofwright__proofwright).
 */
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { type Project, ProjectError } from "../project.js";

export const PROMPTS = [
  {
    name: "proofwright",
    description:
      "Test something from one plain sentence: Playwright's planner drafts, you approve the test cases, Playwright's generator writes only the approved ones, and Proofwright reviews them and proves they can fail.",
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

/**
 * Claude Code splits what the tester types after a prompt command on spaces
 * and gives each declared argument one word, dropping the rest (measured in
 * 2.1.236): "/…proofwright check that coupon codes work" arrives as "check".
 * The AI still sees everything the tester typed, so the prompt tells it to use
 * that — rather than declaring extra arguments, which Claude Code would list
 * in its menu ("arguments: request, w2, w3 …").
 */
const SPLITS_ARGUMENTS = new Set(["claude-code"]);

export function renderPrompt(name: string, args: Record<string, string>, project?: Project, client?: string): GetPromptResult {
  if (name !== "proofwright") throw new ProjectError(`There is no prompt called "${name}".`);
  const request = (args.request ?? "").trim();
  if (!request) throw new ProjectError("Say what to test, e.g. \"check that coupon codes work at checkout\".");
  const cut = client !== undefined && SPLITS_ARGUMENTS.has(client);
  const slug = cut ? "<name>" : slugFor(request);
  const plan = `specs/${slug}.plan.md`;
  const asked = cut
    ? `The tester's request is everything they typed after the command, in their own words. (This app gives Proofwright only the first word: "${request}".) Use their full words wherever this says "the request" — and name the plan specs/<name>.plan.md, <name> being 2 to 5 words from the request, lower case, joined with hyphens (for example coupon-codes-checkout).`
    : `The tester asked: "${request}"`;
  const setup = [
    ...(project?.config.project ? [`project "${project.config.project}"`] : []),
    ...(project?.config.seed ? [`seed file "${project.config.seed}"`] : []),
  ];
  const where = [
    ...(setup.length > 0 ? [`Set the page up (planner_setup_page, and later generator_setup_page) with ${setup.join(" and ")}.`] : []),
    ...(project?.config.testsDir ? [`Put each test's file under \`${project.config.testsDir}/\`.`] : []),
  ].join(" ");
  const requirements = project?.config.requirements?.length
    ? `what the app promises in ${project.config.requirements.map((r) => `\`${r}\``).join(" and ")}`
    : "what the app promises (ask the tester where its requirements are written, if you don't know)";
  const text = `${asked}

Run Proofwright's guided session. The tester is in charge: show them each Proofwright answer as it is, stop wherever it says "What to do", and never answer those questions or approve anything for them. Write to the tester in clear, simple English: short, and only what they need.

Rules for every step — tell Playwright's agents too:
- Expected results come from the request and from ${requirements}. Never read the app's source code to decide what is right: a test written from the code confirms its bugs.
- When the page does something the requirements don't mention, write that expected result starting with "Not promised:". Proofwright then asks the tester whether the app should do it.

1. Plan — with the playwright-test-planner agent. Explore the app for this request, then save the plan with planner_save_plan as \`${plan}\`. Cover the normal path, limits, empty and unusual values, and errors. Assume a fresh state for every test. Give every step an expected result the page can show.${where ? ` ${where}` : ""}

2. Test cases — call Proofwright's approve_plan with plan "${plan}" and request "${cut ? "<the tester's full words>" : request}". Show the tester the answer. If they want changes, change the plan and call approve_plan again.

3. Approval — only when the tester says which cases they approve, call approve_plan again with those case numbers (or ["all"]) and their exact words in \`words\`. Where this app can show a form, Proofwright asks them itself: Accept approves, Decline doesn't. Nothing goes further without their yes.

4. Tests — with the playwright-test-generator agent, write one test per case in the approved plan approve_plan names (\`specs/${slug}.approved.md\`). Keep each test's title exactly as the plan has it: it starts with the case number. Tell the generator:
   - Check each expected result exactly as the approved case says, even when the app does something else. A test that fails on an app bug is the right result: never weaken it to make it pass.
   - Wait for each action to finish (for example its response) before checking what it did.
   - Never write a password or other secret as a fixed value: create it when the test runs.

5. Review — call Proofwright's review on the files the generator wrote, and show the findings.

6. Prove — tell the tester it takes a few minutes, then call Proofwright's prove with paths set to the files the generator wrote${project?.config.project ? ` and project "${project.config.project}"` : ""}. Show the answer: a test that stays green when its own step fails needs a stronger check, and the tester decides how.

Never use the playwright-test-healer agent, and never change what a test expects without the tester's yes. If test data is needed, Proofwright's test_data makes it up — made-up values only.`;
  return {
    description: `Proofwright: ${request}`,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

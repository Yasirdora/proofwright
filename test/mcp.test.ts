/**
 * End to end over stdio, the way an MCP client (Claude Code) talks to Proofwright.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";
import { renderPlan } from "../src/plan/playwright-plan.js";
import { COUPONS } from "./fixtures.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

/** The tester's answer in Proofwright's form: Accept (with optional words), or Decline. */
type FormAnswer = { words?: string } | null;

async function connect(root: string, withForm?: (message: string) => FormAnswer, clientName = "proofwright-test") {
  const client = new Client(
    { name: clientName, version: "0.0.0" },
    withForm ? { capabilities: { elicitation: {} } } : {},
  );
  if (withForm) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const answer = withForm((req.params as { message: string }).message);
      return answer ? { action: "accept", content: answer } : { action: "decline" };
    });
  }
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--root", root] }));
  return client;
}

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

test("mcp: offers its seven tools, with schemas and instructions", async () => {
  const client = await connect(REPO);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["approve_plan", "explain", "guide", "prove", "report", "review", "test_data"]);
    for (const t of tools) assert.ok(t.description && t.description.length > 80 && t.inputSchema.type === "object");
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /the result first, then "What to do"/);
    assert.match(instructions, /clear, simple English/);
    assert.match(instructions, /never from the app's source code/);
    assert.match(instructions, /call guide: without a request it gives their status and the next step/);
    assert.equal(client.getServerVersion()?.name, "proofwright");
  } finally {
    await client.close();
  }
});

test("mcp: review answers in three parts, with the findings as structured content", async () => {
  const client = await connect(REPO);
  try {
    const r = await client.callTool({ name: "review", arguments: { paths: ["demo/colleague"] } });
    assert.ok(!isError(r), text(r));
    const t = text(r);
    assert.ok(t.startsWith("**19 problems in 2 files: 8 must fix, 11 should fix.**"), t.slice(0, 120));
    assert.ok(t.includes("\n**What to do**\n"));
    assert.match(t, /\n\*What I did: .+\*\n$/);
    const data = (r as unknown as { structuredContent: { data: { findings: unknown[] } } }).structuredContent.data;
    assert.equal(data.findings.length, 19);
  } finally {
    await client.close();
  }
});

test("mcp: test_data saves into the project it's given, and asks its questions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-mcp-"));
  const client = await connect(REPO);
  try {
    const r = await client.callTool({
      name: "test_data",
      arguments: {
        root: dir,
        fields: [{ name: "Nickname", kind: "name" }],
        seed: 2,
        today: "2026-09-24",
        save: "profile",
      },
    });
    assert.ok(!isError(r), text(r));
    assert.ok(fs.existsSync(path.join(dir, "proofwright/data/profile.json")));
    assert.ok(text(r).includes("1. Is **Nickname** required?"));
  } finally {
    await client.close();
  }
});

test("mcp: bad input is an error with a plain reason, never a crash", async () => {
  const client = await connect(REPO);
  try {
    const outside = await client.callTool({ name: "review", arguments: { paths: ["../"] } });
    assert.ok(isError(outside));
    assert.match(text(outside), /outside the project/);
    const badKind = await client.callTool({ name: "test_data", arguments: { fields: [{ name: "X", kind: "colour" }] } });
    assert.ok(isError(badKind));
    assert.match(text(badKind), /kind must be one of/);
    const unknown = await client.callTool({ name: "nope", arguments: {} });
    assert.ok(isError(unknown));
    // The server is still answering.
    assert.ok(!isError(await client.callTool({ name: "review", arguments: { paths: ["demo/tests"] } })));
  } finally {
    await client.close();
  }
});

function planProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-mcp-plan-"));
  fs.mkdirSync(path.join(dir, "specs"));
  fs.writeFileSync(path.join(dir, "specs/coupons.plan.md"), renderPlan(COUPONS));
  return dir;
}

test("mcp: approve_plan in an app that can't show a form needs the tester's words", async () => {
  const dir = planProject();
  const client = await connect(dir);
  try {
    const shown = await client.callTool({ name: "approve_plan", arguments: { plan: "specs/coupons.plan.md" } });
    assert.ok(!isError(shown), text(shown));
    assert.match(text(shown), /^\*\*3 test cases to check/);
    const noWords = await client.callTool({ name: "approve_plan", arguments: { plan: "specs/coupons.plan.md", approve: ["TC-001"] } });
    assert.ok(isError(noWords));
    assert.match(text(noWords), /tester's own words/);
    const ok = await client.callTool({ name: "approve_plan", arguments: { plan: "specs/coupons.plan.md", approve: ["TC-001"], words: "yes, TC-001" } });
    assert.ok(!isError(ok), text(ok));
    assert.match(fs.readFileSync(path.join(dir, "proofwright/cases/coupons.md"), "utf8"), /relayed by the AI client/);
  } finally {
    await client.close();
  }
});

test("mcp: approve_plan asks the tester directly when the app can show a form", async () => {
  const dir = planProject();
  let shownToTester = "";
  const client = await connect(dir, (message) => ((shownToTester = message), { words: "looks right" }));
  try {
    const r = await client.callTool({
      name: "approve_plan",
      arguments: { plan: "specs/coupons.plan.md", approve: ["all"], words: "the AI approves" },
    });
    assert.ok(!isError(r), text(r));
    assert.match(shownToTester, /^Approve 2 test cases\?/);
    assert.match(shownToTester, /Accept = approve these cases\. {3}Decline = approve nothing\./);
    const cases = fs.readFileSync(path.join(dir, "proofwright/cases/coupons.md"), "utf8");
    assert.match(cases, /"looks right" \(asked you directly\)/);
    assert.doesNotMatch(cases, /the AI approves/);
  } finally {
    await client.close();
  }
  const declined = await connect(planProject(), () => null);
  try {
    const r = await declined.callTool({ name: "approve_plan", arguments: { plan: "specs/coupons.plan.md", approve: ["TC-001"] } });
    assert.ok(!isError(r), text(r));
    assert.match(text(r), /you declined, so nothing was approved/);
  } finally {
    await declined.close();
  }
  // Accept alone approves: there's no box to tick (testers pressed Accept with it unticked).
  const acceptOnly = await connect(planProject(), () => ({}));
  try {
    const r = await acceptOnly.callTool({ name: "approve_plan", arguments: { plan: "specs/coupons.plan.md", approve: ["TC-001"] } });
    assert.match(text(r), /Approved 1 test case\./);
    assert.match(text(r), /"Approved in Proofwright's form\." \(asked you directly\)|Recorded your approval \(asked you directly\)/);
  } finally {
    await acceptOnly.close();
  }
});

test("mcp: the approval form waits, then closes with a clear answer — nothing approved", async () => {
  const dir = planProject();
  const server = createServer(dir, { formTimeoutMs: 300, desktopApp: false });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "proofwright-test", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, () => new Promise(() => {})); // the tester never answers
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const started = Date.now();
    const r = await client.callTool({ name: "approve_plan", arguments: { plan: "specs/coupons.plan.md", approve: ["TC-001"] } });
    assert.ok(Date.now() - started < 10_000, "it waited the time it was given, not the SDK's own 60 s");
    assert.ok(isError(r));
    assert.equal(text(r), "**I couldn't do that.** The approval form closed after 1 second without an answer, so nothing was approved. Ask again when you're ready.");
    assert.equal(fs.existsSync(path.join(dir, "specs/coupons.approved.md")), false);
  } finally {
    await client.close();
  }
});

test("mcp: the proofwright prompt turns one sentence into the guided session", async () => {
  const client = await connect(REPO);
  try {
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name), ["proofwright"]);
    const p = await client.getPrompt({ name: "proofwright", arguments: { request: "check that coupon codes work at checkout" } });
    const body = (p.messages[0].content as { text: string }).text;
    for (const needle of [
      "playwright-test-planner",
      "specs/coupon-codes-work-checkout.plan.md",
      "approve_plan",
      "their exact words",
      "playwright-test-generator",
      "specs/coupon-codes-work-checkout.approved.md",
      "review",
      "Never use the playwright-test-healer",
      "call Proofwright's prove",
      'with paths set to the files the generator wrote and project "generated"',
      "the tester decides how",
      // the rules from the owner's walkthrough
      "Expected results come from the request and from what the app promises in `demo/README.md`",
      "Never read the app's source code",
      'starting with "Not promised:"',
      "Check each expected result exactly as the approved case says, even when the app does something else",
      "Wait for each action to finish",
      "Never write a password or other secret as a fixed value",
      "Accept approves, Decline doesn't",
      // the rules from the owner's second walkthrough, and the guided steps
      "Every step must be something a user can do on the page — no direct API calls",
      'Start each step\'s message with "Step N of 6 — <name>", and end it with the next step',
      "first check the app's address is free: Playwright's generator often leaves the app running",
      "do their work yourself with the playwright-test tools",
      "Proofwright's guide tool says where the tester is and what comes next",
      // this repository's proofwright/config.json
      'project "generated" and seed file "demo/generated/seed.spec.ts"',
      "under `demo/generated/`",
    ]) {
      assert.ok(body.includes(needle), needle);
    }
    await assert.rejects(() => client.getPrompt({ name: "proofwright", arguments: { request: " " } }));
  } finally {
    await client.close();
  }
});

test("mcp: guide — without a request, where the tester is; with one, the session's steps with their whole sentence", async () => {
  const dir = planProject();
  // As Claude Code: the guide gets the full sentence ($ARGUMENTS), so no first-word note.
  const client = await connect(dir, undefined, "claude-code");
  try {
    const status = await client.callTool({ name: "guide", arguments: {} });
    assert.match(text(status), /^\*\*Checkout coupons: 1 of 6 steps done\.\*\*/);
    assert.match(text(status), /\*\*What to do\*\*\nTurn the plan into test cases for you to check: say "show me the test cases"\./);
    const steps = await client.callTool({ name: "guide", arguments: { request: "check that the sign-up form refuses bad emails" } });
    const body = text(steps);
    assert.match(body, /^The tester asked: "check that the sign-up form refuses bad emails"/);
    assert.match(body, /specs\/sign-up-form-refuses-bad-emails\.plan\.md/);
    assert.doesNotMatch(body, /only the first word/);
    assert.equal((steps as { structuredContent?: unknown }).structuredContent, undefined, "steps for the AI, not an answer for the tester");
  } finally {
    await client.close();
  }
});

test("mcp: in the Claude desktop app, which declines forms unseen, the tester approves in the chat", async () => {
  const dir = planProject();
  const server = createServer(dir, { desktopApp: true });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "2.1.281" }, { capabilities: { elicitation: {} } });
  let asked = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => ((asked += 1), { action: "decline" as const }));
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const noWords = await client.callTool({ name: "approve_plan", arguments: { plan: "specs/coupons.plan.md", approve: ["TC-001"] } });
    assert.ok(isError(noWords));
    assert.match(text(noWords), /tester's own words/);
    const ok = await client.callTool({ name: "approve_plan", arguments: { plan: "specs/coupons.plan.md", approve: ["TC-001"], words: "yes, TC-001 is right" } });
    assert.match(text(ok), /^\*\*Approved 1 test case\./);
    assert.equal(asked, 0, "no form was sent: the app would decline it without showing it");
    assert.match(fs.readFileSync(path.join(dir, "proofwright/cases/coupons.md"), "utf8"), /"yes, TC-001 is right" \(your words, relayed by the AI client\)/);
  } finally {
    await client.close();
  }
});

test("mcp: in Claude Code, which passes a prompt only the first word, the AI is told to use everything the tester typed", async () => {
  const client = await connect(REPO, undefined, "claude-code");
  try {
    // What Claude Code sends for "/mcp__proofwright__proofwright check that coupon codes work at checkout" (2.1.236).
    const p = await client.getPrompt({ name: "proofwright", arguments: { request: "check" } });
    const body = (p.messages[0].content as { text: string }).text;
    assert.match(body, /^The tester's request is everything they typed after the command, in their own words\. \(This app gives Proofwright only the first word: "check"\.\)/);
    assert.match(body, /name the plan specs\/<name>\.plan\.md, <name> being 2 to 5 words from the request/);
    assert.match(body, /request "<the tester's full words>"/);
    assert.doesNotMatch(body, /The tester asked: "check"/);
    assert.doesNotMatch(body, /specs\/plan\.plan\.md/);
  } finally {
    await client.close();
  }
});

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
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { renderPlan } from "../src/plan/playwright-plan.js";
import { COUPONS } from "./fixtures.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function connect(root: string, withForm?: (message: string) => { approve: boolean; words?: string } | null) {
  const client = new Client(
    { name: "proofwright-test", version: "0.0.0" },
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

test("mcp: offers review, test_data and approve_plan, with schemas and instructions", async () => {
  const client = await connect(REPO);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["approve_plan", "review", "test_data"]);
    for (const t of tools) assert.ok(t.description && t.description.length > 80 && t.inputSchema.type === "object");
    assert.match(client.getInstructions() ?? "", /What I did, What I found, What I need from you/);
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
    assert.ok(t.startsWith("**19 problems in 2 files: 8 high, 11 medium.**"), t.slice(0, 120));
    for (const h of ["### What I did", "### What I found", "### What I need from you"]) assert.ok(t.includes(h), h);
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
    assert.match(text(shown), /^\*\*3 test cases from Playwright's plan/);
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
  const client = await connect(dir, (message) => ((shownToTester = message), { approve: true, words: "looks right" }));
  try {
    const r = await client.callTool({
      name: "approve_plan",
      arguments: { plan: "specs/coupons.plan.md", approve: ["all"], words: "the AI approves" },
    });
    assert.ok(!isError(r), text(r));
    assert.match(shownToTester, /Proofwright: approve 2 test cases/);
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
    assert.match(text(r), /you didn't, so nothing was approved/);
  } finally {
    await declined.close();
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

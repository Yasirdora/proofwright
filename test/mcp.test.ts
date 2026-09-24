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

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function connect(root: string) {
  const client = new Client({ name: "proofwright-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--root", root] }));
  return client;
}

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

test("mcp: offers review and test_data, with schemas and instructions", async () => {
  const client = await connect(REPO);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["review", "test_data"]);
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

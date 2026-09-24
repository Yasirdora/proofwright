import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { init } from "../src/init.js";
import { Project, ProjectError } from "../src/project.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

function playwrightProject(mcp?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-init-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "shop-tests", devDependencies: { "@playwright/test": "1.61.1" } }));
  fs.writeFileSync(path.join(dir, "playwright.config.ts"), 'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "tests" });\n');
  if (mcp) fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify(mcp, null, 2));
  return dir;
}

test("init: shows what it would change, and changes nothing without --yes", () => {
  const dir = playwrightProject();
  const a = init(new Project(dir), false);
  assert.equal(a.data.planned.length, 4);
  assert.deepEqual(a.need, ["If that's what you want, run `proofwright init --yes`."]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["node_modules", "package.json", "playwright.config.ts"]);
});

test("init --yes: Playwright's agents, Proofwright next to them — and the tester's other MCP servers kept", () => {
  const dir = playwrightProject({ mcpServers: { "my-other-server": { command: "echo", args: ["hi"] } } });
  const a = init(new Project(dir), true);
  assert.ok(fs.existsSync(path.join(dir, ".claude/agents/playwright-test-planner.md")));
  assert.ok(fs.existsSync(path.join(dir, ".claude/agents/playwright-test-generator.md")));
  const mcp = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ["my-other-server", "playwright-test", "proofwright"]);
  assert.deepEqual(mcp.mcpServers["my-other-server"], { command: "echo", args: ["hi"] });
  assert.equal(mcp.mcpServers.proofwright.args[1], "mcp");
  assert.deepEqual(a.data.restoredServers, ["my-other-server"], "Playwright's init-agents drops it; init puts it back");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "proofwright/config.json"), "utf8")), { ignore: [] });
  assert.match(a.found, /healer/);
  assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /^proofwright\/runs\/$/m, "run evidence stays out of git");

  const again = init(new Project(dir), true);
  assert.equal(again.headline, "This project is already set up.");
});

test("init: refuses a folder that isn't a Playwright project", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-init-"));
  assert.throws(() => init(new Project(dir), true), /no package\.json/);
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  assert.throws(() => init(new Project(dir), true), (e: unknown) => e instanceof ProjectError && /doesn't use Playwright Test/.test((e as Error).message));
});

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLAUDE_COMMAND, COPILOT_SKILL, init } from "../src/init.js";
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
  assert.equal(a.data.planned.length, 5);
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
  // The short command, with the tester's whole sentence as $ARGUMENTS.
  assert.equal(fs.readFileSync(path.join(dir, ".claude/commands/proofwright.md"), "utf8"), CLAUDE_COMMAND);
  assert.match(CLAUDE_COMMAND, /^argument-hint: "\[what to test\]"$/m, "quoted: Copilot CLI refuses the hint as a list");
  assert.match(CLAUDE_COMMAND, /request set to exactly those words/);
  assert.match(a.next ?? "", /`\/proofwright check that … works`/);
  assert.ok(!fs.existsSync(path.join(dir, ".github")), "nothing for Copilot unless asked");

  const again = init(new Project(dir), true);
  assert.equal(again.headline, "This project is already set up.");
});

test("init --copilot: Playwright's agents for Copilot, a Proofwright skill, the servers in .mcp.json — and no cloud workflow", () => {
  const dir = playwrightProject();
  fs.mkdirSync(path.join(dir, "proofwright"));
  fs.writeFileSync(path.join(dir, "proofwright/config.json"), JSON.stringify({ ignore: [], project: "e2e" }));
  fs.writeFileSync(path.join(dir, "playwright.config.ts"), 'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ projects: [{ name: "unit", testDir: "unit" }, { name: "e2e", testDir: "e2e" }] });\n');
  const a = init(new Project(dir), true, { copilot: true });
  for (const agent of ["planner", "generator"]) assert.ok(fs.existsSync(path.join(dir, `.github/agents/playwright-test-${agent}.agent.md`)), agent);
  assert.equal(fs.readFileSync(path.join(dir, ".github/skills/proofwright/SKILL.md"), "utf8"), COPILOT_SKILL);
  assert.ok(!fs.existsSync(path.join(dir, ".github/workflows/copilot-setup-steps.yml")), "Copilot CLI doesn't need the cloud agent's workflow");
  assert.ok(a.did.some((d) => d.startsWith("Removed the workflow Playwright's Copilot setup adds")));
  const mcp = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ["playwright-test", "proofwright"], "Copilot CLI reads .mcp.json too");
  // Playwright's seed test goes into the project Proofwright's config names, not the first one.
  assert.ok(fs.existsSync(path.join(dir, "e2e/seed.spec.ts")));
  assert.ok(!fs.existsSync(path.join(dir, "unit/seed.spec.ts")));
  // Playwright names a model its Copilot agents must use; a Copilot without it can't start them. The line goes.
  for (const agent of ["planner", "generator", "healer"]) {
    const file = path.join(dir, `.github/agents/playwright-test-${agent}.agent.md`);
    if (fs.existsSync(file)) assert.doesNotMatch(fs.readFileSync(file, "utf8"), /^model:/m, agent);
  }
  assert.ok(a.did.includes("Removed the fixed model from Playwright's Copilot agents: they use your session's model."));
  assert.match(a.next ?? "", /in Copilot CLI, start it in this folder, trust the folder, and type the same `\/proofwright check that … works`/);
  assert.equal(init(new Project(dir), true, { copilot: true }).headline, "This project is already set up.");
  // Agents a project already had, still with the model line: init takes it out.
  const planner = path.join(dir, ".github/agents/playwright-test-planner.agent.md");
  fs.writeFileSync(planner, fs.readFileSync(planner, "utf8").replace(/^name: .*$/m, (l) => `${l}\nmodel: Claude Sonnet 4.6`));
  const plan = init(new Project(dir), false, { copilot: true });
  assert.ok(plan.data.planned.some((p) => p.startsWith("For GitHub Copilot CLI: remove the fixed model")), plan.data.planned.join(" | "));
  init(new Project(dir), true, { copilot: true });
  assert.doesNotMatch(fs.readFileSync(planner, "utf8"), /^model:/m);
});

test("init --antigravity: Antigravity's settings name the project's own Playwright, its config and the project by full path", () => {
  const dir = playwrightProject({ mcpServers: {} });
  fs.mkdirSync(path.join(dir, ".agents"));
  fs.writeFileSync(path.join(dir, ".agents/mcp_config.json"), JSON.stringify({ mcpServers: { other: { command: "other-server" } } }));
  const project = new Project(dir);
  const a = init(project, true, { antigravity: true });
  const servers = JSON.parse(fs.readFileSync(path.join(dir, ".agents/mcp_config.json"), "utf8")).mcpServers;
  assert.deepEqual(servers.other, { command: "other-server" }, "the file's other servers are kept");
  assert.equal(servers.proofwright.command, process.execPath);
  assert.deepEqual(servers.proofwright.args.slice(1), ["mcp", "--root", project.root], "started in /, it still knows the project");
  assert.equal(servers["playwright-test"].command, process.execPath);
  const [cli, ...rest] = servers["playwright-test"].args;
  assert.equal(fs.realpathSync(cli), fs.realpathSync(path.join(REPO, "node_modules/playwright/cli.js")), "the project's own Playwright — not whatever npx finds in /");
  assert.deepEqual(rest, ["run-test-mcp-server", "--config", path.join(project.root, "playwright.config.ts")]);
  // Paths on this computer: never committed.
  assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /^\.agents\/mcp_config\.json$/m);
  assert.ok(a.did.includes("Wrote `.agents/mcp_config.json` for Antigravity: Proofwright's and Playwright's servers, by full path."));
  assert.match(a.next ?? "", /in Antigravity, reload the window, then ask it to use Proofwright to check that … works/);
  assert.equal(init(project, true, { antigravity: true }).headline, "This project is already set up.");

  // Without Playwright installed, there's nothing to point at: say so.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-init-"));
  fs.writeFileSync(path.join(bare, "package.json"), JSON.stringify({ devDependencies: { "@playwright/test": "1.61.1" } }));
  assert.throws(() => init(new Project(bare), false, { antigravity: true }), /Playwright isn't installed in this project yet: run `npm install` here first/);
});

test("init: .mcp.json is written only when a server changes — never just reformatted", () => {
  const dir = playwrightProject();
  init(new Project(dir), true);
  const compact = JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8")));
  fs.writeFileSync(path.join(dir, ".mcp.json"), compact);
  fs.rmSync(path.join(dir, ".claude/commands/proofwright.md"));
  init(new Project(dir), true);
  assert.equal(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"), compact);
});

test("init: refuses a folder that isn't a Playwright project", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-init-"));
  assert.throws(() => init(new Project(dir), true), /no package\.json/);
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  assert.throws(() => init(new Project(dir), true), (e: unknown) => e instanceof ProjectError && /doesn't use Playwright Test/.test((e as Error).message));
});

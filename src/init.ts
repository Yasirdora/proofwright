/**
 * `proofwright init` — set a tester's Playwright project up once:
 *
 *   1. Playwright's own test agents (`npx playwright init-agents --loop=claude`):
 *      the planner and generator, their MCP server, a seed test and specs/.
 *   2. Proofwright's MCP server, next to Playwright's, in .mcp.json.
 *   3. proofwright/config.json, for paths Proofwright must never read.
 *
 * It shows what it would change and changes nothing without --yes. Playwright's
 * init-agents replaces .mcp.json outright, dropping the project's other MCP
 * servers; init puts every one of them back and says so.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type Answer, count } from "./answer.js";
import { type Project, ProjectError } from "./project.js";

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InitData {
  planned: string[];
  done: string[];
  restoredServers: string[];
}

const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));

export function init(project: Project, apply: boolean): Answer<InitData> {
  const pkgFile = path.join(project.root, "package.json");
  if (!fs.existsSync(pkgFile)) throw new ProjectError("There's no package.json here — run init in the root of a Playwright project.");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as Record<string, Record<string, string> | undefined>;
  if (!pkg.dependencies?.["@playwright/test"] && !pkg.devDependencies?.["@playwright/test"]) {
    throw new ProjectError("This project doesn't use Playwright Test: @playwright/test isn't in package.json.");
  }

  const mcpFile = path.join(project.root, ".mcp.json");
  const before = readMcp(mcpFile);
  const hasAgents = fs.existsSync(path.join(project.root, ".claude/agents/playwright-test-planner.md"));
  const hasProofwright = Boolean(before.mcpServers?.proofwright);
  const configFile = path.join(project.root, "proofwright/config.json");
  const hasConfig = fs.existsSync(configFile);

  const planned = [
    ...(hasAgents ? [] : ["Install Playwright's test agents: `npx playwright init-agents --loop=claude` (the planner, the generator, their MCP server, a seed test, specs/)."]),
    ...(hasProofwright ? [] : ["Add Proofwright's MCP server to `.mcp.json`, next to Playwright's."]),
    ...(hasConfig ? [] : ["Create `proofwright/config.json` (paths Proofwright must never read — none yet)."]),
  ];
  const otherServers = Object.keys(before.mcpServers ?? {}).filter((n) => n !== "proofwright" && n !== "playwright-test");

  if (planned.length === 0) {
    return {
      headline: "This project is already set up.",
      did: ["Checked Playwright's agents, `.mcp.json` and `proofwright/config.json`. Nothing was changed."],
      found: "Playwright's agents, Proofwright's MCP server and Proofwright's config are all in place.",
      need: [],
      next: "In Claude Code, try: /mcp__proofwright__proofwright check that … works",
      data: { planned, done: [], restoredServers: [] },
    };
  }
  if (!apply) {
    return {
      headline: `${count(planned.length, "change")} to set this project up — nothing changed yet.`,
      did: ["Looked at the project. Nothing was changed."],
      found: [
        "Setting up would:",
        ...planned.map((p) => `- ${p}`),
        ...(!hasAgents && otherServers.length > 0
          ? [`\nPlaywright's init-agents replaces \`.mcp.json\`; your other MCP servers (${otherServers.join(", ")}) would be put back afterwards.`]
          : []),
      ].join("\n"),
      need: ["If that's what you want, run `proofwright init --yes`."],
      data: { planned, done: [], restoredServers: [] },
    };
  }

  const done: string[] = [];
  let restoredServers: string[] = [];
  if (!hasAgents) {
    execFileSync("npx", ["--no-install", "playwright", "init-agents", "--loop=claude"], {
      cwd: project.root,
      stdio: "pipe",
      env: { ...process.env, CI: "1" },
    });
    done.push("Installed Playwright's test agents (planner, generator, healer) and their MCP server.");
  }
  const after = readMcp(mcpFile);
  const servers: Record<string, unknown> = { ...(after.mcpServers ?? {}) };
  restoredServers = otherServers.filter((n) => !(n in servers));
  for (const n of restoredServers) servers[n] = before.mcpServers![n];
  servers.proofwright ??= { command: process.execPath, args: [CLI, "mcp"] };
  fs.writeFileSync(mcpFile, `${JSON.stringify({ ...before, ...after, mcpServers: servers }, null, 2)}\n`);
  if (!hasProofwright) done.push("Added Proofwright's MCP server to `.mcp.json`.");
  if (restoredServers.length > 0) done.push(`Put back the MCP servers Playwright's init-agents removed from \`.mcp.json\`: ${restoredServers.join(", ")}.`);
  if (!hasConfig) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, `${JSON.stringify({ ignore: [] }, null, 2)}\n`);
    done.push("Created `proofwright/config.json`.");
  }

  return {
    headline: "This project is set up for Proofwright.",
    did: done,
    found: [
      "Playwright's planner and generator explore and write; Proofwright makes the test cases you approve, reviews every test, and makes the test data.",
      "",
      "Playwright also installed its **healer** agent. Proofwright never uses it — it changes what tests expect in order to pass them. You can delete `.claude/agents/playwright-test-healer.md` if you don't want it offered.",
    ].join("\n"),
    need: [],
    next: "Restart Claude Code in this project, then try: /mcp__proofwright__proofwright check that … works",
    data: { planned, done, restoredServers },
  };
}

function readMcp(file: string): McpConfig {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as McpConfig;
  } catch {
    throw new ProjectError(".mcp.json isn't valid JSON — fix it first, so no MCP server in it is lost.");
  }
}

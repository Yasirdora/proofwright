/**
 * `proofwright init` — set a tester's Playwright project up once:
 *
 *   1. Playwright's own test agents (`npx playwright init-agents --loop=claude`):
 *      the planner and generator, their MCP server, a seed test and specs/.
 *   2. Proofwright's MCP server, next to Playwright's, in .mcp.json.
 *   3. proofwright/config.json, for paths Proofwright must never read.
 *   4. proofwright/runs/ in .gitignore — run evidence (screenshots, traces)
 *      stays out of git; the reports don't.
 *   5. The `/proofwright` command for Claude Code (.claude/commands/), in the
 *      terminal and in the desktop app: it passes the tester's whole sentence.
 *
 * With --copilot, it also sets the project up for GitHub Copilot CLI:
 * Playwright's agents for Copilot (.github/agents/), a Proofwright skill
 * (.github/skills/proofwright/), and Playwright's test server in .mcp.json,
 * which Copilot CLI reads too (measured with 1.0.88). Playwright's Copilot
 * setup also writes a workflow for Copilot's cloud agent; the CLI doesn't need
 * it, so init removes it unless it was already there. Playwright's Copilot
 * agents name a model ("Claude Sonnet 4.6"); where the tester's Copilot doesn't
 * offer it, the agent doesn't start (measured with 1.0.88), so init removes
 * that line and the agents use the session's model.
 *
 * With --antigravity, it writes `.agents/mcp_config.json` for Antigravity.
 * Antigravity starts MCP servers outside the project (measured: in `/`), so
 * `npx playwright` there finds another Playwright than the project's and the
 * planner fails ("did not expect test() to be called here"). The file names
 * the project's own Playwright, its config and the project by full path —
 * paths on this computer, so the file goes in .gitignore.
 *
 * It shows what it would change and changes nothing without --yes. Playwright's
 * init-agents replaces .mcp.json outright, dropping the project's other MCP
 * servers; init puts every one of them back and says so.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type Answer, count } from "./answer.js";
import { type Project, ProjectError } from "./project.js";
import { findConfig } from "./prove/wrapper.js";

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

/** `/proofwright` in Claude Code: the whole sentence arrives as $ARGUMENTS. */
export const CLAUDE_COMMAND = `---
description: Test with Proofwright, step by step — or see where you are and what's next
argument-hint: "[what to test]"
---
Proofwright, for this tester.

- If they wrote what to test — "$ARGUMENTS" — call Proofwright's \`guide\` tool with request set to exactly those words, then follow the session steps it returns. The steps are for you; don't show them to the tester.
- If that is empty, call \`guide\` without a request, and show the tester its answer as it is.
`;

/** The same for GitHub Copilot CLI, as a skill. */
export const COPILOT_SKILL = `---
name: proofwright
description: Test a web app with Proofwright, step by step — a plan, test cases the tester approves, Playwright tests, a review, and proof that the tests can fail. Use when the tester asks to test or check something with Proofwright, or asks where they are or what's next.
---
# Proofwright

Use the \`guide\` tool of the proofwright MCP server.

- The tester wants something tested: call \`guide\` with request set to their exact words, then follow the session steps it returns. The steps are for you; don't show them to the tester.
- The tester asks where they are, or what's next: call \`guide\` without a request, and show them its answer as it is.
`;

const PLAYWRIGHT_SERVER = { command: "npx", args: ["playwright", "run-test-mcp-server"] };
const COPILOT_AGENTS = [".github/agents/playwright-test-planner.agent.md", ".github/agents/playwright-test-generator.agent.md", ".github/agents/playwright-test-healer.agent.md"];
const MODEL_LINE = /^model: .*\n/m;
const ANTIGRAVITY_FILE = ".agents/mcp_config.json";

/** Antigravity's MCP settings: full paths, because it starts servers outside the project. */
export function antigravityServers(project: Project): Record<string, unknown> {
  let playwrightCli: string;
  try {
    // Found through its package.json: Playwright's exports don't include cli.js itself.
    const pkgFile = createRequire(path.join(project.root, "package.json")).resolve("playwright/package.json");
    const bin = (JSON.parse(fs.readFileSync(pkgFile, "utf8")) as { bin?: Record<string, string> }).bin?.playwright ?? "cli.js";
    playwrightCli = path.join(path.dirname(pkgFile), bin);
  } catch {
    throw new ProjectError("Playwright isn't installed in this project yet: run `npm install` here first, then init again.");
  }
  return {
    proofwright: { command: process.execPath, args: [CLI, "mcp", "--root", project.root] },
    "playwright-test": { command: process.execPath, args: [playwrightCli, "run-test-mcp-server", "--config", findConfig(project)] },
  };
}

export function init(project: Project, apply: boolean, options: { copilot?: boolean; antigravity?: boolean } = {}): Answer<InitData> {
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
  const gitignore = path.join(project.root, ".gitignore");
  const ignoresRuns = fs.existsSync(gitignore) && /^\/?proofwright\/runs\/?$/m.test(fs.readFileSync(gitignore, "utf8"));
  const commandFile = path.join(project.root, ".claude/commands/proofwright.md");
  const hasCommand = fs.existsSync(commandFile);
  const copilot = options.copilot === true;
  const hasCopilotAgents = fs.existsSync(path.join(project.root, ".github/agents/playwright-test-planner.agent.md"));
  const skillFile = path.join(project.root, ".github/skills/proofwright/SKILL.md");
  const hasSkill = fs.existsSync(skillFile);
  const hasPlaywrightServer = Boolean(before.mcpServers?.["playwright-test"]);
  const pinnedModel = () => COPILOT_AGENTS.map((f) => path.join(project.root, f)).filter((f) => fs.existsSync(f) && MODEL_LINE.test(fs.readFileSync(f, "utf8")));
  const antigravity = options.antigravity === true;
  const antigravityFile = path.join(project.root, ANTIGRAVITY_FILE);
  const antigravityBefore = readMcp(antigravityFile);
  const antigravityWanted = antigravity ? antigravityServers(project) : {};
  const antigravityCurrent = Object.entries(antigravityWanted).every(([n, v]) => JSON.stringify(antigravityBefore.mcpServers?.[n]) === JSON.stringify(v));
  const ignoresAntigravity = fs.existsSync(gitignore) && /^\/?\.agents\/mcp_config\.json$/m.test(fs.readFileSync(gitignore, "utf8"));

  const planned = [
    ...(hasAgents ? [] : ["Install Playwright's test agents: `npx playwright init-agents --loop=claude` (the planner, the generator, their MCP server, a seed test, specs/)."]),
    ...(hasProofwright ? [] : ["Add Proofwright's MCP server to `.mcp.json`, next to Playwright's."]),
    ...(hasConfig ? [] : ["Create `proofwright/config.json` (paths Proofwright must never read — none yet)."]),
    ...(ignoresRuns ? [] : ["Add `proofwright/runs/` to `.gitignore`, so run evidence (screenshots, traces) stays out of git."]),
    ...(hasCommand ? [] : ["Add the `/proofwright` command for Claude Code (`.claude/commands/proofwright.md`)."]),
    ...(copilot && !hasCopilotAgents ? ["For GitHub Copilot CLI: install Playwright's agents for Copilot (`npx playwright init-agents --loop=copilot`: `.github/agents/`, `.vscode/mcp.json`)."] : []),
    ...(copilot && !hasSkill ? ["For GitHub Copilot CLI: add a Proofwright skill (`.github/skills/proofwright/SKILL.md`)."] : []),
    ...(copilot && !hasPlaywrightServer && hasAgents ? ["For GitHub Copilot CLI: add Playwright's test server to `.mcp.json`."] : []),
    ...(copilot && (!hasCopilotAgents || pinnedModel().length > 0)
      ? ["For GitHub Copilot CLI: remove the fixed model from Playwright's Copilot agents, so they use your session's model (a model your Copilot doesn't offer stops them)."]
      : []),
    ...(antigravity && !antigravityCurrent
      ? ["For Antigravity: write `.agents/mcp_config.json` with Proofwright's and Playwright's servers by full path — Antigravity starts them outside the project, where `npx playwright` finds another Playwright."]
      : []),
    ...(antigravity && !ignoresAntigravity ? ["Add `.agents/mcp_config.json` to `.gitignore`: its paths are this computer's."] : []),
  ];
  const otherServers = Object.keys(before.mcpServers ?? {}).filter((n) => n !== "proofwright" && n !== "playwright-test");

  if (planned.length === 0) {
    return {
      headline: "This project is already set up.",
      did: ["Checked Playwright's agents, `.mcp.json` and `proofwright/config.json`. Nothing was changed."],
      found: "Playwright's agents, Proofwright's MCP server, Proofwright's config and the .gitignore entry are all in place.",
      need: [],
      next: "in Claude Code, try: `/proofwright check that … works`.",
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
      // The same flags again: without them, --yes wouldn't do the Copilot or Antigravity part.
      need: [`If that's what you want, run \`proofwright init${copilot ? " --copilot" : ""}${antigravity ? " --antigravity" : ""} --yes\`.`],
      data: { planned, done: [], restoredServers: [] },
    };
  }

  const done: string[] = [];
  let restoredServers: string[] = [];
  // Playwright's setup writes its seed test into the first project in the config unless told
  // which one: the project Proofwright's config names, when it names one.
  const forProject = project.config.project ? ["--project", project.config.project] : [];
  if (!hasAgents) {
    execFileSync("npx", ["--no-install", "playwright", "init-agents", "--loop=claude", ...forProject], {
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
  const merged = { ...before, ...after, mcpServers: servers };
  // Written only when a server changes — never just reformatted.
  if (JSON.stringify(merged) !== JSON.stringify(readMcp(mcpFile))) fs.writeFileSync(mcpFile, `${JSON.stringify(merged, null, 2)}\n`);
  if (!hasProofwright) done.push("Added Proofwright's MCP server to `.mcp.json`.");
  if (restoredServers.length > 0) done.push(`Put back the MCP servers Playwright's init-agents removed from \`.mcp.json\`: ${restoredServers.join(", ")}.`);
  if (!hasConfig) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, `${JSON.stringify({ ignore: [] }, null, 2)}\n`);
    done.push("Created `proofwright/config.json`.");
  }
  if (!ignoresRuns) {
    const before = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
    fs.writeFileSync(gitignore, `${before}${before && !before.endsWith("\n") ? "\n" : ""}\n# Proofwright's run evidence (screenshots, traces)\nproofwright/runs/\n`);
    done.push("Added `proofwright/runs/` to `.gitignore`.");
  }
  if (!hasCommand) {
    fs.mkdirSync(path.dirname(commandFile), { recursive: true });
    fs.writeFileSync(commandFile, CLAUDE_COMMAND);
    done.push("Added the `/proofwright` command for Claude Code.");
  }
  if (copilot) {
    if (!hasCopilotAgents) {
      const workflow = path.join(project.root, ".github/workflows/copilot-setup-steps.yml");
      const hadWorkflow = fs.existsSync(workflow);
      execFileSync("npx", ["--no-install", "playwright", "init-agents", "--loop=copilot", ...forProject], { cwd: project.root, stdio: "pipe", env: { ...process.env, CI: "1" } });
      done.push("Installed Playwright's agents for GitHub Copilot (`.github/agents/`, and `.vscode/mcp.json` for VS Code).");
      if (!hadWorkflow && fs.existsSync(workflow)) {
        fs.rmSync(workflow);
        done.push("Removed the workflow Playwright's Copilot setup adds for Copilot's cloud agent (`.github/workflows/copilot-setup-steps.yml`): Copilot CLI doesn't need it.");
      }
    }
    const pinned = pinnedModel();
    for (const f of pinned) fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(MODEL_LINE, ""));
    if (pinned.length > 0) done.push("Removed the fixed model from Playwright's Copilot agents: they use your session's model.");
    if (!hasSkill) {
      fs.mkdirSync(path.dirname(skillFile), { recursive: true });
      fs.writeFileSync(skillFile, COPILOT_SKILL);
      done.push("Added a Proofwright skill for GitHub Copilot CLI.");
    }
    const current = readMcp(mcpFile);
    if (!current.mcpServers?.["playwright-test"]) {
      fs.writeFileSync(mcpFile, `${JSON.stringify({ ...current, mcpServers: { ...(current.mcpServers ?? {}), "playwright-test": PLAYWRIGHT_SERVER } }, null, 2)}\n`);
      done.push("Added Playwright's test server to `.mcp.json`, where Copilot CLI finds it.");
    }
  }

  if (antigravity) {
    if (!antigravityCurrent) {
      fs.mkdirSync(path.dirname(antigravityFile), { recursive: true });
      const merged = { ...antigravityBefore, mcpServers: { ...(antigravityBefore.mcpServers ?? {}), ...antigravityWanted } };
      fs.writeFileSync(antigravityFile, `${JSON.stringify(merged, null, 2)}\n`);
      done.push("Wrote `.agents/mcp_config.json` for Antigravity: Proofwright's and Playwright's servers, by full path.");
    }
    if (!ignoresAntigravity) {
      const text = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
      fs.writeFileSync(gitignore, `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n# Antigravity's MCP settings: paths on this computer\n.agents/mcp_config.json\n`);
      done.push("Added `.agents/mcp_config.json` to `.gitignore`.");
    }
  }

  return {
    headline: "This project is set up for Proofwright.",
    did: done,
    found: [
      "Playwright's planner and generator explore and write; Proofwright makes the test cases you approve, reviews every test, and makes the test data.",
      "",
      `Playwright also installed its **healer** agent. Proofwright never uses it — it changes what tests expect in order to pass them. You can delete \`.claude/agents/playwright-test-healer.md\`${copilot ? " and `.github/agents/playwright-test-healer.agent.md`" : ""} if you don't want it offered.`,
    ].join("\n"),
    need: [],
    next: [
      "restart Claude Code in this project, then try: `/proofwright check that … works`",
      ...(copilot ? ["in Copilot CLI, start it in this folder, trust the folder, and type the same `/proofwright check that … works`"] : []),
      ...(antigravity ? ["in Antigravity, reload the window, then ask it to use Proofwright to check that … works"] : []),
    ].join(" — ") + ".",
    data: { planned, done, restoredServers },
  };
}

function readMcp(file: string): McpConfig {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as McpConfig;
  } catch {
    const name = file.endsWith(ANTIGRAVITY_FILE) ? ANTIGRAVITY_FILE : ".mcp.json";
    throw new ProjectError(`${name} isn't valid JSON — fix it first, so no MCP server in it is lost.`);
  }
}

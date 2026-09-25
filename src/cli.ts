#!/usr/bin/env node
/**
 * proofwright — the command line.
 *
 *   proofwright mcp [--root DIR]                     start the MCP server on stdio
 *   proofwright guide [--root DIR]                   where you are, and the next step
 *   proofwright init [--yes] [--copilot] [--antigravity] [--root DIR] set a Playwright project up
 *   proofwright review [PATH ...] [--root DIR] [--json]
 *   proofwright report [--run] [--project P] [--grep G] [--from FILE] [--root DIR]
 *   proofwright explain TEST [--run-id ID] [--root DIR]
 *   proofwright prove [PATH ...] [--project P] [--grep G] [--endpoint E ...] [--faults K,K] [--max-runs N] [--root DIR]
 *   proofwright --version | --help
 */
import { renderAnswer } from "./answer.js";
import { guide } from "./guide/guide.js";
import { init } from "./init.js";
import { VERSION, serveStdio } from "./mcp/server.js";
import { Project, ProjectError } from "./project.js";
import { review } from "./review/review.js";
import { FAULT_KINDS, type FaultKind } from "./prove/proxy.js";
import { proveTool } from "./prove/tool.js";
import { explain, report } from "./runs/tools.js";

const USAGE = `Proofwright ${VERSION} — works with a human tester on Playwright tests.

Usage:
  proofwright mcp [--root DIR]                       Start the MCP server (stdio)
  proofwright guide [--root DIR]                     Where each test session is, and the next step
  proofwright init [--yes] [--copilot] [--antigravity] [--root DIR]
                                                     Set a Playwright project up: Playwright's
                                                     agents, Proofwright's MCP server, its config,
                                                     the /proofwright command (--copilot: for
                                                     GitHub Copilot CLI too; --antigravity: for
                                                     Antigravity). Shows the changes; makes them
                                                     only with --yes
  proofwright review [PATH ...] [--root DIR] [--json]
                                                     Review test scripts against the rules
  proofwright report [--run] [--project P] [--grep G] [--from FILE] [--root DIR]
                                                     The one-page report: --run runs Playwright's
                                                     runner now; --from reads a JSON report;
                                                     neither reports on the last recorded run
  proofwright explain TEST [--run-id ID] [--root DIR]
                                                     Explain one failure: part of its title, TC-001,
                                                     or file:line
  proofwright prove [PATH ...] [--project P] [--grep G] [--endpoint E ...] [--faults error,empty,slow,malformed]
                    [--max-runs N] [--slow-ms N] [--config FILE] [--root DIR]
                                                     Prove tests can fail: run them with the app's
                                                     API calls broken on purpose, one at a time
  proofwright --version                              Print the version
  proofwright --help                                 Print this help

--root is the tester's project (default: the current folder).`;

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i === -1) return false;
    args.splice(i, 1);
    return true;
  };
  const option = (name: string) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) throw new ProjectError(`${name} needs a value.`);
    args.splice(i, 2);
    return value;
  };

  if (flag("--version") || flag("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (flag("--help") || flag("-h") || args.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return args.length === 0 && argv.length === 0 ? 2 : 0;
  }

  const command = args.shift();
  const root = option("--root") ?? process.cwd();
  switch (command) {
    case "mcp":
      await serveStdio(root);
      return -1; // keep running
    case "guide": {
      process.stdout.write(renderAnswer(guide(new Project(root))));
      return 0;
    }
    case "init": {
      const answer = init(new Project(root), flag("--yes"), { copilot: flag("--copilot"), antigravity: flag("--antigravity") });
      process.stdout.write(renderAnswer(answer));
      return 0;
    }
    case "report": {
      const project = option("--project");
      const grep = option("--grep");
      const from = option("--from");
      const run = flag("--run") || project !== undefined || grep !== undefined;
      const paths = args.filter((a) => !a.startsWith("--"));
      const answer = report(new Project(root), {
        ...(run ? { run: { ...(paths.length > 0 ? { paths } : {}), ...(project ? { project } : {}), ...(grep ? { grep } : {}) } } : {}),
        ...(from ? { from } : {}),
      });
      process.stdout.write(renderAnswer(answer));
      return 0;
    }
    case "explain": {
      const runId = option("--run-id");
      const test = args.join(" ").trim();
      if (!test) throw new ProjectError("Say which failure to explain: part of its title, TC-001, or file:line.");
      process.stdout.write(renderAnswer(explain(new Project(root), { test, ...(runId ? { run: runId } : {}) })));
      return 0;
    }
    case "prove": {
      const endpoints: string[] = [];
      for (let e = option("--endpoint"); e !== undefined; e = option("--endpoint")) endpoints.push(e);
      const faults = option("--faults")?.split(",").map((f) => f.trim());
      const wrong = faults?.find((f) => !(FAULT_KINDS as readonly string[]).includes(f));
      if (wrong) throw new ProjectError(`"${wrong}" isn't a fault Proofwright knows: ${FAULT_KINDS.join(", ")}.`);
      const number = (name: string) => {
        const v = option(name);
        if (v === undefined) return undefined;
        if (!/^\d+$/.test(v)) throw new ProjectError(`${name} needs a whole number.`);
        return Number(v);
      };
      const maxRuns = number("--max-runs");
      const slowMs = number("--slow-ms");
      const project = option("--project");
      const grep = option("--grep");
      const config = option("--config");
      const paths = args.filter((a) => !a.startsWith("--"));
      const answer = await proveTool(
        new Project(root),
        {
          ...(paths.length > 0 ? { paths } : {}),
          ...(project ? { project } : {}),
          ...(grep ? { grep } : {}),
          ...(config ? { config } : {}),
          ...(endpoints.length > 0 ? { endpoints } : {}),
          ...(faults ? { faults: faults as FaultKind[] } : {}),
          ...(maxRuns !== undefined ? { maxRuns } : {}),
          ...(slowMs !== undefined ? { slowMs } : {}),
        },
        (message) => process.stderr.write(`${message}\n`),
      );
      process.stdout.write(renderAnswer(answer));
      return 0;
    }
    case "review": {
      const json = flag("--json");
      const answer = review(new Project(root), args);
      process.stdout.write(json ? `${JSON.stringify(answer.data, null, 2)}\n` : renderAnswer(answer));
      return answer.data.findings.length > 0 ? 1 : 0;
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}\n`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`proofwright: ${err instanceof ProjectError ? err.message : (err as Error).stack}\n`);
    process.exitCode = 2;
  },
);

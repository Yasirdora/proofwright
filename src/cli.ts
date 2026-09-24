#!/usr/bin/env node
/**
 * proofwright — the command line.
 *
 *   proofwright mcp [--root DIR]                     start the MCP server on stdio
 *   proofwright init [--yes] [--root DIR]            set a Playwright project up
 *   proofwright review [PATH ...] [--root DIR] [--json]
 *   proofwright report [--run] [--project P] [--grep G] [--from FILE] [--root DIR]
 *   proofwright explain TEST [--run-id ID] [--root DIR]
 *   proofwright --version | --help
 */
import { renderAnswer } from "./answer.js";
import { init } from "./init.js";
import { VERSION, serveStdio } from "./mcp/server.js";
import { Project, ProjectError } from "./project.js";
import { review } from "./review/review.js";
import { explain, report } from "./runs/tools.js";

const USAGE = `Proofwright ${VERSION} — works with a human tester on Playwright tests.

Usage:
  proofwright mcp [--root DIR]                       Start the MCP server (stdio)
  proofwright init [--yes] [--root DIR]              Set a Playwright project up: Playwright's
                                                     agents, Proofwright's MCP server, its config.
                                                     Shows the changes; makes them only with --yes
  proofwright review [PATH ...] [--root DIR] [--json]
                                                     Review test scripts against the rules
  proofwright report [--run] [--project P] [--grep G] [--from FILE] [--root DIR]
                                                     The one-page report: --run runs Playwright's
                                                     runner now; --from reads a JSON report;
                                                     neither reports on the last recorded run
  proofwright explain TEST [--run-id ID] [--root DIR]
                                                     Explain one failure: part of its title, TC-001,
                                                     or file:line
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
    case "init": {
      const answer = init(new Project(root), flag("--yes"));
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

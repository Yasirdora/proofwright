#!/usr/bin/env node
/**
 * proofwright — the command line.
 *
 *   proofwright mcp [--root DIR]                     start the MCP server on stdio
 *   proofwright review [PATH ...] [--root DIR] [--json]
 *   proofwright --version | --help
 */
import { renderAnswer } from "./answer.js";
import { VERSION, serveStdio } from "./mcp/server.js";
import { Project, ProjectError } from "./project.js";
import { review } from "./review/review.js";

const USAGE = `Proofwright ${VERSION} — works with a human tester on Playwright tests.

Usage:
  proofwright mcp [--root DIR]                       Start the MCP server (stdio)
  proofwright review [PATH ...] [--root DIR] [--json]
                                                     Review test scripts against the rules
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

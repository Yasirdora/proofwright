/**
 * Is this a project Proofwright can work in? Checked before a session starts
 * and before anything runs Playwright, so a tester hears what's missing — once,
 * plainly — instead of an AI working around it (installing packages, writing
 * a plan by hand, copying files between projects).
 *
 * Measured: an AI app can start Proofwright outside any project (Antigravity
 * starts MCP servers in `/`), and a tester can ask for a project that has no
 * Playwright at all.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { Project } from "./project.js";

const INIT = "`node /path/to/proofwright/dist/src/cli.js init`";

/**
 * What's missing, in words for the tester — or undefined when the project is
 * ready. `toRun`: Playwright is about to run, so it must be installed too.
 */
export function notReady(project: Project, options: { toRun?: boolean } = {}): string | undefined {
  const root = project.root;
  if (root === path.parse(root).root) {
    return `Proofwright was started outside any project (in \`${root}\`), so it can't tell which project to test. Start your AI app in the project's folder, or add \`--root /path/to/your/project\` to Proofwright's entry in the app's MCP settings. Nothing was changed.`;
  }
  const pkgFile = path.join(root, "package.json");
  if (!fs.existsSync(pkgFile)) {
    return `\`${root}\` has no package.json, so it isn't a JavaScript or TypeScript project. Proofwright works with Playwright tests in one. Nothing was changed.`;
  }
  let pkg: Record<string, Record<string, string> | undefined> = {};
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  } catch {
    return `\`${root}\`'s package.json isn't valid JSON. Nothing was changed.`;
  }
  const declared = ["dependencies", "devDependencies", "peerDependencies"].some((k) => pkg[k]?.["@playwright/test"] !== undefined);
  const installed = resolves(root, "@playwright/test/package.json");
  const name = path.basename(root);
  if (!declared && !installed) {
    return `${name} has no Playwright tests yet: \`@playwright/test\` isn't in its package.json. Proofwright checks Playwright tests, so the project needs Playwright first — the team adds it (\`npm init playwright@latest\`), then sets Proofwright up in it with ${INIT}. Don't install anything to get past this. Nothing was changed.`;
  }
  if (options.toRun && !installed) {
    return `${name} lists \`@playwright/test\` but it isn't installed. Run \`npm install\` in the project, then try again. Nothing was changed.`;
  }
  return undefined;
}

function resolves(root: string, request: string): boolean {
  try {
    createRequire(path.join(root, "package.json")).resolve(request);
    return true;
  } catch {
    return false;
  }
}

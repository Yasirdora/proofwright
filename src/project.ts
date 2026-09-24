/**
 * The tester's project: where it is, what Proofwright may read, and where it
 * keeps its own files.
 *
 * Everything Proofwright writes lives in a visible `proofwright/` folder at the
 * project root. `proofwright/config.json` may list paths Proofwright must never
 * read — the demo's answer key is the first user of that — and every path a
 * tool is given is checked to stay inside the project.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { globToRegExp } from "./glob.js";

export const STATE_DIR = "proofwright";
const CONFIG_FILE = path.join(STATE_DIR, "config.json");

export interface ProjectConfig {
  /** Globs (project-relative, forward slashes) Proofwright never reads. */
  ignore: string[];
}

export class ProjectError extends Error {}

export class Project {
  readonly root: string;
  readonly config: ProjectConfig;
  private readonly ignored: RegExp[];

  constructor(root: string) {
    const abs = path.resolve(root);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new ProjectError(`The project folder doesn't exist: ${abs}`);
    }
    this.root = abs;
    this.config = readConfig(abs);
    this.ignored = this.config.ignore.map(globToRegExp);
  }

  /** Project-relative, forward-slash form of an absolute path. */
  relative(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  /**
   * Resolve a path a tool was given. Refuses anything outside the project —
   * a tool never reads or writes beyond the folder the tester pointed it at.
   */
  resolve(input: string): string {
    const abs = path.resolve(this.root, input);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ProjectError(`${input} is outside the project (${this.root}).`);
    }
    return abs;
  }

  /** True when proofwright/config.json says this path is off limits. */
  isIgnored(rel: string): boolean {
    return this.ignored.some((re) => re.test(rel));
  }

  /** Absolute path of a file in Proofwright's own folder, creating the folder. */
  stateFile(...parts: string[]): string {
    const abs = path.join(this.root, STATE_DIR, ...parts);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    return abs;
  }
}

function readConfig(root: string): ProjectConfig {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return { ignore: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new ProjectError(`${CONFIG_FILE} isn't valid JSON: ${(err as Error).message}`);
  }
  const ignore = (raw as { ignore?: unknown }).ignore ?? [];
  if (!Array.isArray(ignore) || ignore.some((g) => typeof g !== "string")) {
    throw new ProjectError(`${CONFIG_FILE}: "ignore" must be a list of path patterns.`);
  }
  return { ignore };
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "test-results", "playwright-report", "blob-report"]);

/**
 * Files under the given project-relative paths (files or folders) that match
 * `accept`, skipping dependency and output folders. Returns project-relative
 * paths, sorted, and separately the paths the ignore list kept out.
 */
export function collectFiles(
  project: Project,
  inputs: string[],
  accept: (rel: string) => boolean,
): { files: string[]; ignored: string[] } {
  const files = new Set<string>();
  const ignored = new Set<string>();
  const visit = (abs: string): void => {
    const rel = project.relative(abs);
    if (rel && project.isIgnored(rel)) {
      ignored.add(rel);
      return;
    }
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(abs).sort()) {
        if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
        visit(path.join(abs, entry));
      }
    } else if (stat.isFile() && accept(rel)) {
      files.add(rel);
    }
  };
  for (const input of inputs) {
    const abs = project.resolve(input);
    if (!fs.existsSync(abs)) throw new ProjectError(`${input} doesn't exist in the project.`);
    visit(abs);
  }
  return { files: [...files].sort(), ignored: [...ignored].sort() };
}

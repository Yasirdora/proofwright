/**
 * The wrapper config: how a proof reaches any Playwright project without
 * changing its tests or its config.
 *
 * For the length of a proof, Proofwright writes `.proofwright-prove.config.ts`
 * beside the tester's Playwright config. It imports that config unchanged and
 * adds only the proxy (and, for HTTPS, `ignoreHTTPSErrors`; for evidence,
 * screenshots). It sits in the same folder because Playwright resolves every
 * relative path in a config (testDir, outputDir, webServer's cwd, globalSetup)
 * against the folder of the config it loaded. A `.ts` wrapper loads TypeScript,
 * CommonJS and ESM configs alike, measured on Playwright 1.61.1.
 *
 * The file is deleted when the proof ends, however it ends; one left behind by
 * a proof that was killed is deleted by the next.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Project, ProjectError } from "../project.js";

export const WRAPPER_NAME = ".proofwright-prove.config.ts";

const CONFIG_NAMES = ["ts", "js", "mts", "mjs", "cts", "cjs"].map((ext) => `playwright.config.${ext}`);

/** What the wrapper saw in the tester's config, written when Playwright loads it. */
export interface WrapperInfo {
  /** The config sets a proxy of its own. */
  ownProxy: boolean;
  /** The config tells the browser to accept any certificate. */
  ignoreHTTPSErrors: boolean;
}

export interface Wrapper {
  /** Absolute path of the wrapper. */
  file: string;
  /** Absolute path of the tester's config it loads. */
  config: string;
  /** A wrapper from an interrupted proof was there, and was replaced. */
  leftover: boolean;
  /** Where the wrapper writes WrapperInfo. */
  infoFile: string;
  info(): WrapperInfo | undefined;
  remove(): void;
}

/** The tester's Playwright config: the one named, or playwright.config.* at the project's root. */
export function findConfig(project: Project, given?: string): string {
  if (given) {
    const abs = project.resolve(given);
    if (!fs.existsSync(abs)) throw new ProjectError(`There's no Playwright config at ${given}.`);
    return abs;
  }
  const found = CONFIG_NAMES.map((n) => path.join(project.root, n)).find((f) => fs.existsSync(f));
  if (!found) {
    throw new ProjectError("There's no playwright.config.ts (or .js, .mjs, .cjs) at the project's root. Say which config the tests use, with `config`.");
  }
  return found;
}

export function wrapperSource(configFile: string): string {
  return `// Written by Proofwright for one proof, and deleted when the proof ends.
// It loads your Playwright config unchanged and sends the browser's traffic
// through Proofwright's local proxy, which breaks API calls on purpose.
// If you find it lying around, a proof was interrupted: delete it.
import * as fs from "node:fs";
import base from "./${path.basename(configFile)}";

const server = process.env.PROOFWRIGHT_PROXY;
if (!server) throw new Error("Proofwright: this config is only for a proof that Proofwright runs.");
const uses: any[] = [(base as any).use ?? {}, ...((base as any).projects ?? []).map((p: any) => p.use ?? {})];
const ownProxy = uses.some((u) => u.proxy || u.launchOptions?.proxy);
if (process.env.PROOFWRIGHT_INFO) {
  fs.writeFileSync(process.env.PROOFWRIGHT_INFO, JSON.stringify({ ownProxy, ignoreHTTPSErrors: uses.some((u) => u.ignoreHTTPSErrors === true) }));
}
if (ownProxy) throw new Error("Proofwright: this config sets a proxy of its own, so a proof can't put its own in front.");

const proxy = { server };
const through = (use: any = {}) => ({
  ...use,
  proxy,
  launchOptions: { ...use.launchOptions, proxy },
  ...(process.env.PROOFWRIGHT_HTTPS === "1" ? { ignoreHTTPSErrors: true } : {}),
  screenshot: "on",
});

export default {
  ...(base as any),
  use: through((base as any).use),
  ...((base as any).projects ? { projects: (base as any).projects.map((p: any) => ({ ...p, use: through(p.use) })) } : {}),
};
`;
}

/** Write the wrapper beside the config. Remove it with `remove()` — also done if the process is stopped. */
export function writeWrapper(configFile: string, infoFile: string): Wrapper {
  const file = path.join(path.dirname(configFile), WRAPPER_NAME);
  const leftover = fs.existsSync(file);
  fs.writeFileSync(file, wrapperSource(configFile));
  const onExit = () => fs.rmSync(file, { force: true });
  process.once("exit", onExit);
  return {
    file,
    config: configFile,
    leftover,
    infoFile,
    info() {
      try {
        return JSON.parse(fs.readFileSync(infoFile, "utf8")) as WrapperInfo;
      } catch {
        return undefined;
      }
    },
    remove() {
      fs.rmSync(file, { force: true });
      process.removeListener("exit", onExit);
    },
  };
}

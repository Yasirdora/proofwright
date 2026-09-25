/**
 * prove: the wrapper config on configs of every kind, and a real proof over
 * MCP — Playwright's runner, the demo shop, the colleague's tests.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Project, ProjectError } from "../src/project.js";
import { faultTimeoutFor } from "../src/prove/prove.js";
import type { ProveData } from "../src/prove/tool.js";
import { findConfig, WRAPPER_NAME, writeWrapper } from "../src/prove/wrapper.js";
import { demoCopy, freePort, REPO } from "./fixtures.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

// ---------------------------------------------------------------- the wrapper

test("wrapper: finds the config, writes itself beside it, and goes when removed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-wrap-"));
  const project = new Project(dir);
  assert.throws(() => findConfig(project), /There's no playwright\.config\.ts/);
  fs.mkdirSync(path.join(dir, "e2e"));
  fs.writeFileSync(path.join(dir, "e2e/pw.config.mjs"), "export default {};\n");
  assert.throws(() => findConfig(project, "e2e/missing.config.ts"), ProjectError);
  assert.throws(() => findConfig(project, "../elsewhere.config.ts"), /outside the project/);
  const config = findConfig(project, "e2e/pw.config.mjs");

  const w = writeWrapper(config, path.join(dir, "info.json"));
  assert.equal(w.file, path.join(project.root, "e2e", WRAPPER_NAME));
  assert.equal(w.leftover, false);
  assert.match(fs.readFileSync(w.file, "utf8"), /^import base from "\.\/pw\.config\.mjs";$/m);
  // One an interrupted proof left behind is replaced, and said so.
  const again = writeWrapper(config, path.join(dir, "info.json"));
  assert.equal(again.leftover, true);
  again.remove();
  w.remove();
  assert.ok(!fs.existsSync(w.file));
});

/** A tiny Playwright project whose one test reports the `use` Playwright gave it. */
function tinyProject(configName: string, configSource: string): { dir: string; config: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-cfg-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir");
  fs.mkdirSync(path.join(dir, "tests"));
  fs.writeFileSync(
    path.join(dir, "tests/use.spec.js"),
    `const { test } = require("@playwright/test");
const fs = require("node:fs");
test("use", async ({}, info) => {
  const u = info.project.use;
  fs.writeFileSync(process.env.USE_OUT, JSON.stringify({ proxy: u.proxy, launchProxy: u.launchOptions?.proxy, ignoreHTTPSErrors: u.ignoreHTTPSErrors, screenshot: u.screenshot, baseURL: u.baseURL }));
});
`,
  );
  fs.writeFileSync(path.join(dir, configName), configSource);
  return { dir, config: path.join(dir, configName) };
}

function runWrapped(dir: string, config: string, https: boolean) {
  const w = writeWrapper(config, path.join(dir, "info.json"));
  const out = path.join(dir, "use.json");
  try {
    const r = spawnSync("npx", ["--no-install", "playwright", "test", "--config", w.file, "--reporter=line"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PROOFWRIGHT_PROXY: "http://127.0.0.1:9", PROOFWRIGHT_INFO: w.infoFile, PROOFWRIGHT_HTTPS: https ? "1" : "0", USE_OUT: out },
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}`, use: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : undefined, info: w.info() };
  } finally {
    w.remove();
  }
}

test("wrapper: loads TypeScript, CommonJS and ESM configs unchanged, adding only the proxy", () => {
  const configs: Array<[string, string]> = [
    ["playwright.config.ts", `import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "tests", use: { baseURL: "http://127.0.0.1:1" } });\n`],
    ["playwright.config.js", `const { defineConfig } = require("@playwright/test");\nmodule.exports = defineConfig({ testDir: "tests", projects: [{ name: "p", use: { baseURL: "http://127.0.0.1:2" } }] });\n`],
    ["playwright.config.mjs", `import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "tests", use: { baseURL: "http://127.0.0.1:3" } });\n`],
  ];
  for (const [i, [file, source]] of configs.entries()) {
    const { dir, config } = tinyProject(file, source);
    const r = runWrapped(dir, config, i === 0);
    assert.equal(r.status, 0, `${file}: ${r.output}`);
    assert.deepEqual(r.use.proxy, { server: "http://127.0.0.1:9" }, file);
    assert.deepEqual(r.use.launchProxy, { server: "http://127.0.0.1:9" }, file);
    assert.equal(r.use.baseURL, `http://127.0.0.1:${i + 1}`, `${file}: the config's own settings stay`);
    assert.equal(r.use.screenshot, "on", file);
    // HTTPS is opened only when the proxy can: only then does the browser accept its certificate.
    assert.equal(r.use.ignoreHTTPSErrors, i === 0 ? true : undefined, file);
    assert.deepEqual(r.info, { ownProxy: false, ignoreHTTPSErrors: false }, file);
    assert.ok(!fs.existsSync(path.join(dir, WRAPPER_NAME)));
  }
});

test("wrapper: a config with a proxy of its own is refused before any test runs", () => {
  const { dir, config } = tinyProject(
    "playwright.config.ts",
    `export default { testDir: "tests", use: { proxy: { server: "http://corp-proxy:3128" }, ignoreHTTPSErrors: true } };\n`,
  );
  const r = runWrapped(dir, config, false);
  assert.notEqual(r.status, 0);
  assert.match(r.output, /sets a proxy of its own/);
  assert.equal(r.use, undefined);
  assert.deepEqual(r.info, { ownProxy: true, ignoreHTTPSErrors: true });
});

test("fault runs stop a stuck test sooner — never later than the tests' own timeout", () => {
  assert.equal(faultTimeoutFor(2_500, 30_000), 10_000);
  assert.equal(faultTimeoutFor(6_000, 30_000), 18_000);
  assert.equal(faultTimeoutFor(2_500, 8_000), undefined, "a 10 s limit would be longer than their 8 s");
  assert.equal(faultTimeoutFor(12_000, 30_000), undefined);
  assert.equal(faultTimeoutFor(0, Number.POSITIVE_INFINITY), 10_000);
});

// ---------------------------------------------------------------- a real proof, over MCP

async function connect(root: string, port: string) {
  const client = new Client({ name: "proofwright-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--root", root], env: { ...(process.env as Record<string, string>), SHOP_PORT: port } }),
  );
  return client;
}

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");

test("prove, over MCP: the coupon test passes while applying the coupon fails; checkout catches its order failing", async () => {
  const project = demoCopy(["demo/colleague"]);
  const client = await connect(project.root, await freePort());
  const heard: Array<{ progress: number; total?: number; message?: string }> = [];
  try {
    const r = await client.callTool(
      {
        name: "prove",
        arguments: {
          paths: ["demo/colleague/checkout.spec.ts"],
          project: "colleague",
          endpoints: ["POST /api/cart/coupon", "POST /api/orders", "nothing-like-this"],
          faults: ["error"],
        },
      },
      undefined,
      { onprogress: (p) => heard.push(p), timeout: 10 * 60_000, resetTimeoutOnProgress: true },
    );
    assert.ok(!(r as { isError?: boolean }).isError, text(r));
    const proof = (r as unknown as { structuredContent: { data: ProveData } }).structuredContent.data;
    const verdict = Object.fromEntries(proof.tests.map((t) => [t.title, t.verdict]));
    assert.deepEqual(verdict, {
      "user can sign up": "not proven",
      "add to cart works": "not proven",
      "coupon works": "passes when its own action fails",
      checkout: "catches",
      "order number is shown": "not proven",
      // Flaky, or (when its tries happened to pass) none of its calls were broken: either way, not proven.
      "recommendations › recommendations load": "not proven",
    });
    assert.deepEqual(proof.runs.map((x) => x.label), ["POST /api/cart/coupon fails with a server error", "POST /api/orders fails with a server error"]);
    assert.deepEqual(proof.unmatched, ["nothing-like-this"]);

    const coupon = proof.tests.find((t) => t.title === "coupon works")!;
    assert.equal(coupon.reason, "It still passes when POST /api/cart/coupon fails with a server error.");
    const shot = coupon.missed[0].evidence?.screenshot;
    assert.ok(shot && fs.existsSync(path.join(project.root, shot)), "the page it passed on is kept");
    assert.ok(coupon.missed[0].evidence?.trace && fs.existsSync(path.join(project.root, coupon.missed[0].evidence.trace)));
    assert.equal(proof.tests.find((t) => t.title === "add to cart works")!.reason, "None of the calls it makes were among the ones you asked me to break.");

    const t = text(r);
    assert.ok(t.startsWith("**6 tests: 1 passes when its own action fails, 1 catches what breaks, 4 not proven.**"), t.slice(0, 160));
    assert.match(t, /"coupon works" \(demo\/colleague\/checkout\.spec\.ts:25\): make it check that POST \/api\/cart\/coupon worked/);
    assert.match(t, /No call matched "nothing-like-this"/);

    // Nothing of the tester's changed: no wrapper left, no test-results/, the report kept.
    assert.ok(!fs.existsSync(path.join(project.root, WRAPPER_NAME)));
    assert.ok(!fs.existsSync(path.join(project.root, "test-results")));
    assert.ok(fs.existsSync(path.join(project.root, proof.reportFile)));
    assert.ok(fs.existsSync(path.join(project.root, proof.dir, "proof.json")));

    // Where it was, as it went: the clean run, then each fault run.
    assert.deepEqual(heard.map((p) => p.progress), [0, 1, 2]);
    assert.match(heard[2].message ?? "", /^Run 2 of 2: POST \/api\/orders fails with a server error$/);
  } finally {
    await client.close();
  }
});

test("prove, over MCP: a test.only stops the proof and is named", async () => {
  const project = demoCopy(["demo/colleague"]);
  const client = await connect(project.root, await freePort());
  try {
    const r = await client.callTool({ name: "prove", arguments: { project: "colleague" } });
    assert.equal((r as { isError?: boolean }).isError, true);
    assert.match(text(r), /Playwright stopped: `test\.only` at demo\/colleague\/wip\.spec\.ts:3 would narrow the proof to that test/);
    assert.ok(!fs.existsSync(path.join(project.root, WRAPPER_NAME)));
    const bad = await client.callTool({ name: "prove", arguments: { faults: ["on-fire"] } });
    assert.match(text(bad), /"on-fire" isn't a fault Proofwright knows: error, empty, malformed, slow\./);
  } finally {
    await client.close();
  }
});

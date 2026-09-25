/**
 * prove: the wrapper config on configs of every kind, and a real proof over
 * MCP — Playwright's runner, the demo shop, the colleague's tests.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Project, ProjectError } from "../src/project.js";
import { faultTimeoutFor, isApiCall } from "../src/prove/prove.js";
import { explain } from "../src/runs/tools.js";
import { type ProveData, proveTool } from "../src/prove/tool.js";
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

test(`prove, over MCP: the coupon test stays green while "Apply" fails; checkout catches its order failing`, async () => {
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
          // Not the flaky "recommendations" test: its verdict would change from run to run.
          grep: "^(?!.*recommendations)",
          endpoints: ["POST /api/cart/coupon", "POST /api/orders", "GET /api/me", "nothing-like-this"],
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
      // Only a background read of theirs was broken, and they didn't notice: nothing broken made them fail.
      "user can sign up": "can't fail",
      "add to cart works": "can't fail",
      "coupon works": "misses its own action",
      checkout: "catches",
      "order number is shown": "not proven",
    });
    assert.deepEqual(proof.unmatched, ["nothing-like-this"]);

    // The step, from the trace, in words a tester knows — and its line.
    const coupon = proof.tests.find((t) => t.title === "coupon works")!;
    assert.equal(coupon.result, 'Stays green when "Apply" (checkout.spec.ts:30) fails.');
    assert.equal(coupon.todo, 'After that step, check something the page shows only when "Apply" worked.');
    assert.ok(coupon.evidence?.screenshot && fs.existsSync(path.join(project.root, coupon.evidence.screenshot)), "the page it passed on is kept");
    assert.ok(coupon.evidence?.trace && fs.existsSync(path.join(project.root, coupon.evidence.trace)));
    // The evidence is the run behind the verdict — "Apply" failing — not a background read it didn't need.
    assert.match(coupon.evidence!.screenshot!, /\/error-post-api-cart-coupon\/screenshot\.png$/);
    const kept = fs.readdirSync(path.join(project.root, path.dirname(proof.proofFile)), { recursive: true }).map(String);
    assert.ok(!kept.some((f) => f.includes("error-get-api-me")), `no screenshot for a read nobody needed: ${kept.join(", ")}`);

    // Short: the result, the table of what needs attention, what to do, one line on what was done.
    const t = text(r);
    assert.ok(t.startsWith("**5 tests checked: 3 need a better check, 1 is good, 1 can't be checked yet.**"), t.slice(0, 160));
    assert.match(t, /\| \[coupon works\]\(demo\/colleague\/checkout\.spec\.ts:25\) \| ❌ Stays green when "Apply" \(checkout\.spec\.ts:30\) fails\. \|/);
    assert.match(t, /No call matched "nothing-like-this"\./);
    assert.match(t, /\*\*Next:\*\* make the 3 tests marked ❌ check what their own step did — say "fix the tests prove flagged"/);
    assert.ok(t.length < 4000, `the answer is ${t.length} characters`);
    // The data for the AI is small — a summary; the whole proof is in a file.
    assert.deepEqual(Object.keys(proof).sort(), ["counts", "id", "proofFile", "reportFile", "tests", "unmatched"]);
    for (const x of proof.tests) {
      assert.deepEqual(Object.keys(x).filter((k) => !["title", "file", "line", "verdict", "result", "todo", "slow", "evidence"].includes(k)), [], x.title);
    }
    assert.ok(JSON.stringify(proof).length < 8000);

    // Nothing of the tester's changed: no wrapper left, no test-results/; the report and the proof kept.
    assert.ok(!fs.existsSync(path.join(project.root, WRAPPER_NAME)));
    assert.ok(!fs.existsSync(path.join(project.root, "test-results")));
    assert.ok(fs.existsSync(path.join(project.root, proof.reportFile)));
    assert.ok(fs.existsSync(path.join(project.root, proof.proofFile)));
    assert.match(fs.readFileSync(path.join(project.root, proof.reportFile), "utf8"), /## What each test noticed/);
    // The proof keeps the fingerprint of the file it proved, so the guide can tell later whether it changed.
    const saved = JSON.parse(fs.readFileSync(path.join(project.root, proof.proofFile), "utf8")) as { files: Record<string, string> };
    const spec = "demo/colleague/checkout.spec.ts";
    assert.deepEqual(saved.files, { [spec]: createHash("sha256").update(fs.readFileSync(path.join(project.root, spec))).digest("hex") });

    // Where it was, as it went: the clean run, then each fault run.
    assert.deepEqual(heard.map((p) => p.progress), [0, 1, 2, 3]);
    assert.match(heard[2].message ?? "", /^Run 2 of 3: POST \/api\/orders fails with a server error$/);
  } finally {
    await client.close();
  }
});

/** Two tests that apply SAVE10 twice: one checks the page right after the 2nd "Apply", one waits for its answer. */
const REPEAT = `import { expect, test, type Page } from "@playwright/test";

async function cartWithMug(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Add Blue mug to cart" }).click();
  await page.getByRole("link", { name: "Cart (1)" }).click();
  await expect(page.getByTestId("subtotal")).toHaveText("€12.00");
  await page.getByLabel("Coupon code").fill("SAVE10");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("discount")).toHaveText("−€1.20");
}

test("re-applying SAVE10 changes nothing (checked right away)", async ({ page }) => {
  await cartWithMug(page);
  await page.getByLabel("Coupon code").fill("SAVE10");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("discount")).toHaveText("−€1.20");
});

test("re-applying SAVE10 changes nothing (checked after its answer)", async ({ page }) => {
  await cartWithMug(page);
  await page.getByLabel("Coupon code").fill("SAVE10");
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/cart/coupon") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Apply" }).click();
  await answered;
  await expect(page.getByTestId("discount")).toHaveText("−€1.20");
});
`;

test(`prove: a step repeated — the answers to the 2nd "Apply" late and different show a test that checks the page too early`, async () => {
  const project = demoCopy(["demo/generated"]);
  fs.writeFileSync(path.join(project.root, "demo/generated/repeat.spec.ts"), REPEAT);
  process.env.SHOP_PORT = await freePort();
  try {
    const answer = await proveTool(project, {
      paths: ["demo/generated/repeat.spec.ts"],
      project: "generated",
      endpoints: ["POST /api/cart/coupon"],
      faults: ["error"],
    });
    const [early, waits] = ["checked right away", "checked after its answer"].map((w) => answer.data.tests.find((t) => t.title.includes(w))!);
    // The shop really doubles the discount on a repeat (a planted bug): the early check never sees it.
    assert.equal(early.verdict, "misses its own action");
    assert.equal(early.result, 'Stays green when the answers to the 2nd "Apply" (repeat.spec.ts:16) come late and different: it checks the page before they arrive.');
    assert.equal(early.todo, 'Wait until the page has updated after the 2nd "Apply" before checking it — for example, for a message it shows, or for the data it loads again.');
    // The one that waits sees the bug in the clean run already: it isn't blamed, and isn't "to fix".
    assert.equal(waits.verdict, "not proven");
    assert.match(waits.result, /^Can't be checked: it already fails with nothing broken/);
    assert.equal(waits.todo, "Find out why with explain. If the app is wrong, report the bug — don't change the test to make it pass. Prove it again once it passes.");
    // …and explain can read that failure right away: prove kept the run with nothing broken.
    const kept = answer.did.find((d) => d.startsWith("Kept the run with nothing broken as run "));
    assert.ok(kept, answer.did.join(" | "));
    const why = explain(project, { test: "checked after its answer" });
    assert.equal(why.data.diagnosis.kind, "app bug");
    assert.ok(kept.includes(why.data.run), `${kept} / ${why.data.run}`);
  } finally {
    delete process.env.SHOP_PORT;
  }
});

test("prove: the web app's manifest isn't a server call — every browser fetches it, whatever the test does", () => {
  const call = (c: Partial<{ action: boolean; json: boolean; path: string }>) => ({ action: false, json: true, path: "/api/cart", ...c });
  assert.equal(isApiCall(call({})), true);
  assert.equal(isApiCall(call({ path: "/manifest.webmanifest" })), false);
  assert.equal(isApiCall(call({ path: "/app/manifest.json?v=2" })), false);
  assert.equal(isApiCall(call({ action: true, json: false, path: "/manifest.json" })), true, "a call that changes something always counts");
  assert.equal(isApiCall(call({ json: false, path: "/styles.css" })), false);
});

/** Two tests on a page that never talks to a server: one passes, one looks for what isn't there. */
const NO_SERVER = `import { expect, test } from "@playwright/test";

test("the page greets", async ({ page }) => {
  await page.setContent("<h1>Hello</h1>");
  await expect(page.getByRole("heading", { name: "Hello" })).toBeVisible();
});

test("the page says goodbye", async ({ page }) => {
  await page.setContent("<h1>Hello</h1>");
  await expect(page.getByRole("heading", { name: "Goodbye" })).toBeVisible({ timeout: 1000 });
});
`;

test("prove: an app that makes no server calls — said plainly, no test blamed; a failure is kept for explain", async () => {
  const project = demoCopy(["demo/colleague"]);
  fs.writeFileSync(path.join(project.root, "demo/colleague/no-server.spec.ts"), NO_SERVER);
  process.env.SHOP_PORT = await freePort();
  try {
    const a = await proveTool(project, { paths: ["demo/colleague/no-server.spec.ts"], project: "colleague" });
    assert.equal(a.headline, "Prove can't check these tests: the app made no server calls.");
    assert.ok(
      a.found.startsWith(
        "Prove checks a test by breaking the app's calls to its server and seeing whether the test notices. While your 2 tests ran, the app made no such calls — it works in the browser, or the tests never reached its server — so there was nothing to break. This says nothing against the tests; prove can't check an app like this yet.",
      ),
      a.found,
    );
    const [greets, goodbye] = ["greets", "goodbye"].map((w) => a.data.tests.find((t) => t.title.includes(w))!);
    assert.deepEqual([greets.verdict, greets.result], ["not proven", "Not checked: the app made no server calls, so there was nothing to break."]);
    assert.match(goodbye.result, /^Can't be checked: it already fails with nothing broken/);
    // Only the failing test needs a row; nothing is marked ❌.
    assert.doesNotMatch(a.found, /\| \[the page greets\]/);
    assert.match(a.found, /\| \[the page says goodbye\]/);
    assert.doesNotMatch(a.found, /❌/);
    assert.match(a.did[0], /, and stopped there: there was nothing to break\.$/);
    // Explain reads the failure at once — and a missing element is the app's or the test's: the screenshot tells.
    const why = explain(project, { test: "goodbye" });
    assert.equal(why.data.diagnosis.kind, "app or test");
    assert.match(why.headline, /^App or test \(possible\): nothing like getByRole\('heading', \{ name: 'Goodbye' \}\) is on the page\.$/);
  } finally {
    delete process.env.SHOP_PORT;
  }
});

test("prove: when the app's address is already in use, it says so plainly", async () => {
  const project = demoCopy(["demo/colleague"]);
  const port = await freePort();
  const holder = spawn(process.execPath, ["-e", `require("http").createServer((q, r) => r.end("ok")).listen(${port}, "127.0.0.1", () => console.log("ready"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => holder.stdout!.once("data", resolve));
  process.env.SHOP_PORT = port;
  try {
    await assert.rejects(
      () => proveTool(project, { paths: ["demo/colleague/checkout.spec.ts"], project: "colleague" }),
      (e: unknown) => e instanceof ProjectError && e.message.startsWith(`The app's address http://127.0.0.1:${port}/api/health is already in use, so Playwright couldn't start the app.`),
    );
    assert.ok(!fs.existsSync(path.join(project.root, WRAPPER_NAME)), "the temporary config is gone");
    assert.ok(!fs.existsSync(path.join(project.root, "proofwright/runs/proofs")), "no empty proof folder is left behind");
  } finally {
    holder.kill();
    delete process.env.SHOP_PORT;
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
    assert.ok(!fs.existsSync(path.join(project.root, "proofwright/runs/proofs")), "no empty proof folder is left behind");
    const bad = await client.callTool({ name: "prove", arguments: { faults: ["on-fire"] } });
    assert.match(text(bad), /"on-fire" isn't a fault Proofwright knows: error, empty, malformed, slow\./);
  } finally {
    await client.close();
  }
});

/**
 * The setup check: before a session starts, or anything runs Playwright, the
 * tester hears plainly what's missing — nothing is installed or written to get
 * past it. Measured in trials: an app that started Proofwright in `/`, and a
 * project with no Playwright at all, where an AI then wrote a plan by hand,
 * installed packages and copied tests from another project.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { guide } from "../src/guide/guide.js";
import { sessionText } from "../src/mcp/prompts.js";
import { renderPlan } from "../src/plan/playwright-plan.js";
import { approvePlan } from "../src/plan/tool.js";
import { Project, ProjectError } from "../src/project.js";
import { prove } from "../src/prove/prove.js";
import { runPlaywright } from "../src/runs/runs.js";
import { notReady } from "../src/setup.js";
import { COUPONS, REPO } from "./fixtures.js";

function folder(pkg?: unknown): Project {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-setup-"));
  if (pkg !== undefined) fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  return new Project(dir);
}
const WEB_APP = { name: "web-app", devDependencies: { vite: "7.0.0" } };
const LISTED = { name: "shop-tests", devDependencies: { "@playwright/test": "1.61.1" } };

test("setup: outside any project, with no package.json, or without Playwright — each said plainly", () => {
  assert.match(notReady(new Project("/")) ?? "", /^Proofwright was started outside any project \(in `\/`\).*add `--root \/path\/to\/your\/project`/);
  assert.match(notReady(folder()) ?? "", /has no package\.json, so it isn't a JavaScript or TypeScript project/);
  const web = notReady(folder(WEB_APP)) ?? "";
  assert.match(web, /has no Playwright tests yet: `@playwright\/test` isn't in its package\.json/);
  assert.match(web, /the team adds it \(`npm init playwright@latest`\), then sets Proofwright up in it with `node \/path\/to\/proofwright\/dist\/src\/cli\.js init`/);
  assert.match(web, /Don't install anything to get past this\. Nothing was changed\.$/);
  // Listed but not installed: fine for planning, not for running.
  assert.equal(notReady(folder(LISTED)), undefined);
  assert.match(notReady(folder(LISTED), { toRun: true }) ?? "", /lists `@playwright\/test` but it isn't installed\. Run `npm install`/);
  // Listed and installed: ready to run.
  assert.equal(notReady(new Project(REPO), { toRun: true }), undefined);
  // Installed without being listed in this package.json (a workspace's hoisted packages): ready too.
  const hoisted = folder(WEB_APP);
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(hoisted.root, "node_modules"), "dir");
  assert.equal(notReady(hoisted, { toRun: true }), undefined);
});

test("setup: a project without Playwright — the guide says so, the session doesn't start, nothing is written", async () => {
  const p = folder(WEB_APP);
  fs.mkdirSync(path.join(p.root, "specs"));
  fs.writeFileSync(path.join(p.root, "specs/coupons.plan.md"), renderPlan(COUPONS));

  const g = guide(p);
  assert.equal(g.headline, "This project isn't ready for Proofwright yet.");
  assert.match(g.found, /has no Playwright tests yet/);

  const steps = sessionText("check that coupons work", p);
  assert.match(steps, /^Stop: this session can't start\. Tell the tester exactly this, and do nothing else — don't install anything, don't write a plan by hand, and don't copy plans or tests from another project:/);
  assert.doesNotMatch(steps, /1\. Plan/);

  await assert.rejects(() => approvePlan(p, { plan: "specs/coupons.plan.md" }), (e: unknown) => e instanceof ProjectError && /has no Playwright tests yet/.test(e.message));
  assert.ok(!fs.existsSync(path.join(p.root, "proofwright")), "no test cases were written");

  // Running Playwright needs it installed: said before anything starts.
  const listed = folder(LISTED);
  await assert.rejects(() => prove(listed), /isn't installed\. Run `npm install`/);
  assert.throws(() => runPlaywright(listed), /isn't installed\. Run `npm install`/);
  assert.ok(!fs.existsSync(path.join(listed.root, "proofwright")), "no proof folder, no run");
});

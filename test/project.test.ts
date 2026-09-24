import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { globToRegExp } from "../src/glob.js";
import { collectFiles, Project, ProjectError } from "../src/project.js";

function tempProject(config?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-project-"));
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, "proofwright"));
    fs.writeFileSync(path.join(dir, "proofwright/config.json"), typeof config === "string" ? config : JSON.stringify(config));
  }
  return dir;
}

test("glob: a folder pattern covers the folder and everything under it", () => {
  for (const g of ["demo/answer-key", "demo/answer-key/", "demo/answer-key/**"]) {
    const re = globToRegExp(g);
    assert.ok(re.test("demo/answer-key"), g);
    assert.ok(re.test("demo/answer-key/bugs.spec.ts"), g);
    assert.ok(!re.test("demo/answer-keys/x.ts"), g);
  }
  assert.ok(globToRegExp("tests/*.spec.ts").test("tests/a.spec.ts"));
  assert.ok(!globToRegExp("tests/*.spec.ts").test("tests/deep/a.spec.ts"));
  assert.ok(globToRegExp("**/*.spec.ts").test("a/b/c.spec.ts"));
});

test("project: paths outside the project are refused", () => {
  const p = new Project(tempProject());
  assert.throws(() => p.resolve("../elsewhere"), ProjectError);
  assert.throws(() => p.resolve("/etc/passwd"), ProjectError);
  assert.equal(p.relative(p.resolve("a/b.ts")), "a/b.ts");
});

test("project: the ignore list keeps paths out, and collectFiles reports them", () => {
  const dir = tempProject({ ignore: ["secret"] });
  fs.mkdirSync(path.join(dir, "secret"));
  fs.writeFileSync(path.join(dir, "secret/key.spec.ts"), "");
  fs.writeFileSync(path.join(dir, "open.spec.ts"), "");
  const { files, ignored } = collectFiles(new Project(dir), ["."], () => true);
  assert.deepEqual(files, ["open.spec.ts", "proofwright/config.json"]);
  assert.deepEqual(ignored, ["secret"]);
});

test("project: a broken config is reported plainly", () => {
  assert.throws(() => new Project(tempProject("{ not json")), /config\.json isn't valid JSON/);
  assert.throws(() => new Project(tempProject({ ignore: "all" })), /"ignore" must be a list/);
  assert.throws(() => new Project(path.join(os.tmpdir(), "no-such-folder-proofwright")), /doesn't exist/);
});

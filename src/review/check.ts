/**
 * Proofwright's own review checks — the ones eslint-plugin-playwright doesn't
 * have (see eslint.ts for the ones it does): tests that hand data to each
 * other, run-in-order mode, one account shared by several tests, passwords and
 * real-looking personal data written into tests, retries, the old
 * selector-string page API, and `.fixme` left in.
 *
 * Each file is parsed with the TypeScript compiler and walked once; nothing is
 * executed. The walk also reports where each test starts and ends, and which
 * helpers assert, so the plugin's findings can be placed in their test.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { RULES, type RuleId, type Severity } from "./rules.js";

export interface Finding {
  rule: RuleId;
  severity: Severity;
  title: string;
  /** Project-relative path. */
  file: string;
  /** First line (1-based). */
  line: number;
  /** Every line the finding covers, when it groups several. */
  lines: number[];
  /** The source line, trimmed. */
  code: string;
  /** The test it sits in, when it's inside one. */
  test?: string;
  /** What is specific to this occurrence, in plain words. */
  detail?: string;
  /** Who checked it: "proofwright", or "eslint-plugin-playwright/<rule>". */
  source: string;
}

export interface TestSpan {
  title: string;
  start: number;
  end: number;
  /** Declared with .skip or .fixme — it never runs, so the skip is its finding. */
  skipped: boolean;
}

export interface FileAnalysis {
  text: string;
  lines: string[];
  tests: TestSpan[];
  /** Helper functions that assert (in this file, or imported from a relative module). */
  assertingHelpers: string[];
  findings: Finding[];
}

/** The older page-level API that takes a selector string instead of a locator. */
const PAGE_SELECTOR_API = new Set([
  "click", "dblclick", "fill", "type", "press", "check", "uncheck", "hover", "tap", "focus", "selectOption",
  "setInputFiles", "textContent", "innerText", "innerHTML", "getAttribute", "inputValue", "isVisible", "isHidden",
  "isChecked", "isEnabled", "isDisabled", "isEditable", "dispatchEvent",
]);

const PAGE_LIKE = /^(page|frame|popup)$|Page$/;
const SECRET_HINT = /pass(word)?|passwd|pwd|secret|token|api[-_ ]?key/i;
const SECRET_PROPERTY = /^(password|passwd|pwd|confirmPassword|secret|token|accessToken|authToken|apiKey|api_key)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/;
const RESERVED_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;

interface TestDecl extends TestSpan {
  body: ts.Node;
}

interface Context {
  test?: TestDecl;
}

export function analyzeFile(abs: string, rel: string): FileAnalysis {
  const sf = parse(abs);
  const lines = sf.text.split(/\r?\n/);
  const found: Finding[] = [];
  const add = (ctx: Context, rule: RuleId, node: ts.Node, detail?: string, lineOverride?: number) => {
    const line = lineOverride ?? lineOf(sf, node);
    found.push(finding(rule, rel, line, lines, ctx.test?.title, detail, "proofwright"));
  };

  const sharedLets = moduleLets(sf);
  const tests: TestDecl[] = [];
  const writers = new Map<string, Set<TestDecl>>();
  const readers = new Map<string, Set<TestDecl>>();
  const emails: Array<{ email: string; test: TestDecl; node: ts.Node }> = [];

  const visit = (node: ts.Node, ctx: Context): void => {
    if (ts.isCallExpression(node)) {
      const decl = testDecl(node, sf);
      if (decl) {
        tests.push(decl);
        if (calleePath(node.expression).endsWith(".fixme")) add(ctx, "skipped-test", node, `"${decl.title}" is switched off with .fixme.`);
        for (const arg of node.arguments) visit(arg, { test: decl });
        return;
      }
      checkCall(node, ctx);
    } else if (ts.isPropertyAssignment(node) && ctx.test) {
      const name = propertyName(node.name);
      if (name && SECRET_PROPERTY.test(name) && isStringLiteralish(node.initializer)) {
        add(ctx, "secret-in-test", node, `\`${name}\` is set to a fixed value.`);
      }
    } else if (ts.isStringLiteralLike(node)) {
      const m = EMAIL.exec(node.text);
      if (m && !RESERVED_DOMAIN.test(m[1])) add(ctx, "personal-data", node, `\`${m[0]}\` is on a real domain.`);
      if (m && ctx.test) emails.push({ email: m[0].toLowerCase(), test: ctx.test, node });
    } else if (ts.isIdentifier(node) && ctx.test && sharedLets.has(node.text) && !isDeclarationName(node)) {
      const bucket = isWrite(node) ? writers : readers;
      if (!bucket.has(node.text)) bucket.set(node.text, new Set());
      bucket.get(node.text)!.add(ctx.test);
    }
    ts.forEachChild(node, (child) => visit(child, ctx));
  };

  const checkCall = (call: ts.CallExpression, ctx: Context) => {
    const callee = calleePath(call.expression);
    const name = calleeName(call.expression);
    const firstArg = call.arguments[0];
    const receiver = ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : undefined;
    const onPage = receiver !== undefined && ts.isIdentifier(receiver) && PAGE_LIKE.test(receiver.text);

    // page.fill("input[name=…]") — the selector-string API, where a label or role exists.
    if (name && PAGE_SELECTOR_API.has(name) && onPage && firstArg && ts.isStringLiteralLike(firstArg)) {
      add(ctx, "fragile-selector", call, `\`${(receiver as ts.Identifier).text}.${name}("${firstArg.text}")\` finds the element by selector text.`);
    }

    // A password typed in as a fixed value.
    if (name === "fill" || name === "type" || name === "pressSequentially") {
      const valueArg = onPage ? call.arguments[1] : call.arguments[0];
      const target = onPage && firstArg && ts.isStringLiteralLike(firstArg) ? firstArg.text : receiver ? receiver.getText(sf) : "";
      if (valueArg && isStringLiteralish(valueArg) && SECRET_HINT.test(target)) {
        add(ctx, "secret-in-test", call, "A password is typed in as a fixed value.");
      }
    }

    if (callee === "test.describe.configure") {
      const opts = firstArg;
      if (opts && ts.isObjectLiteralExpression(opts)) {
        const mode = property(opts, "mode");
        if (mode && ts.isStringLiteralLike(mode) && mode.text === "serial") {
          add(ctx, "serial-mode", call, "`mode: \"serial\"` — each test depends on the ones before it.");
        }
        const retries = property(opts, "retries");
        if (retries && ts.isNumericLiteral(retries) && Number(retries.text) > 0) {
          add(ctx, "retries", call, `\`retries: ${retries.text}\` — a test can fail ${retries.text} times and still count as passed.`);
        }
      }
    }
    if (callee === "test.describe.fixme") add(ctx, "skipped-test", call, "A `describe` block switched off with .fixme.");
  };

  ts.forEachChild(sf, (child) => visit(child, {}));

  // Module-level variables that tests use to hand data to each other.
  for (const [name, declLine] of sharedLets) {
    const w = writers.get(name);
    if (!w || w.size === 0) continue;
    const r = [...(readers.get(name) ?? [])].filter((t) => !w.has(t));
    const names = (set: Iterable<TestDecl>) => [...set].map((t) => `"${t.title}"`).join(", ");
    add({}, "shared-state", sf, `\`${name}\` is written by ${names(w)}${r.length > 0 ? ` and read by ${names(r)}` : ""}.`, declLine);
    for (const t of r) add({ test: t }, "shared-state", t.body, `"${t.title}" only works after ${names(w)} has run.`, t.start);
  }

  // One account, many tests: the same email typed into more than one test.
  const firstTest = new Map<string, TestDecl>();
  const reported = new Set<string>();
  for (const e of emails) {
    const first = firstTest.get(e.email);
    if (!first) {
      firstTest.set(e.email, e.test);
      continue;
    }
    const key = `${e.email}|${e.test.title}`;
    if (first !== e.test && !reported.has(key)) {
      reported.add(key);
      add({ test: e.test }, "shared-account", e.node, `"${e.test.title}" uses ${e.email}, which "${first.title}" also uses.`);
    }
  }

  return {
    text: sf.text,
    lines,
    tests: tests.map(({ title, start, end, skipped }) => ({ title, start, end, skipped })),
    assertingHelpers: [...helpersThatAssert(sf, abs)],
    findings: found,
  };
}

/** Build a finding with the rule's severity and title. */
export function finding(
  rule: RuleId,
  file: string,
  line: number,
  lines: string[],
  test: string | undefined,
  detail: string | undefined,
  source: string,
): Finding {
  return {
    rule,
    severity: RULES[rule].severity,
    title: RULES[rule].title,
    file,
    line,
    lines: [line],
    code: (lines[line - 1] ?? "").trim(),
    ...(test ? { test } : {}),
    ...(detail ? { detail } : {}),
    source,
  };
}

/**
 * Is this a Playwright test file? It imports @playwright/test (or
 * playwright/test) itself, or through a local module it imports — the usual
 * fixtures file. Jest, Vitest and node:test files next to the Playwright specs
 * are not, and the review rules would only misread them.
 */
export function usesPlaywright(abs: string, depth = 1): boolean {
  // The compiler's own import scanner: real imports and requires only, never text inside strings.
  const specs = ts.preProcessFile(fs.readFileSync(abs, "utf8"), true, true).importedFiles.map((f) => f.fileName);
  if (specs.some((s) => s === "@playwright/test" || s === "playwright/test")) return true;
  if (depth === 0) return false;
  return specs
    .filter((s) => s.startsWith("."))
    .some((s) => {
      const target = resolveModule(path.dirname(abs), s);
      return target !== null && usesPlaywright(target, depth - 1);
    });
}

// ---------------------------------------------------------------- helpers

function parse(abs: string): ts.SourceFile {
  const text = fs.readFileSync(abs, "utf8");
  const kind = /\.[cm]?tsx$/.test(abs)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(abs)
      ? ts.ScriptKind.TS
      : /\.jsx$/.test(abs)
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  return ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, kind);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** "test.describe.configure" for a chain of names; "" when the chain has calls in it. */
function calleePath(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const left = calleePath(expr.expression);
    return left ? `${left}.${expr.name.text}` : "";
  }
  return "";
}

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

/** A `test(title, [details], body)` declaration, including .only/.skip/.fixme/.fail forms. */
function testDecl(call: ts.CallExpression, sf: ts.SourceFile): TestDecl | null {
  const callee = calleePath(call.expression);
  if (!/^(test|it)(\.(only|skip|fixme|fail|slow))?$/.test(callee)) return null;
  const first = call.arguments[0];
  if (!first || !(ts.isStringLiteralLike(first) || ts.isTemplateExpression(first))) return null;
  const body = [...call.arguments].reverse().find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
  if (!body) return null;
  const title = ts.isStringLiteralLike(first) ? first.text : first.getText(sf).slice(1, -1);
  return {
    title,
    start: lineOf(sf, call),
    end: sf.getLineAndCharacterOfPosition(call.getEnd()).line + 1,
    skipped: /\.(skip|fixme)$/.test(callee),
    body,
  };
}

function property(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propertyName(p.name) === name) return p.initializer;
  }
  return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function isStringLiteralish(e: ts.Expression): boolean {
  return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e);
}

/** `let`/`var` declared at the top of the file: name → line. */
function moduleLets(sf: ts.SourceFile): Map<string, number> {
  const out = new Map<string, number>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st) || st.declarationList.flags & ts.NodeFlags.Const) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) out.set(d.name.text, lineOf(sf, st));
    }
  }
  return out;
}

function isDeclarationName(id: ts.Identifier): boolean {
  return ts.isVariableDeclaration(id.parent) && id.parent.name === id;
}

function isWrite(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    ts.isBinaryExpression(p) &&
    p.left === id &&
    p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

function containsAssertion(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const p = calleePath(n.expression);
      if (p === "expect" || p.startsWith("expect.")) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/**
 * Names of helper functions that assert — in this file, or imported from a
 * relative module (one level) — so a test that calls one isn't reported as
 * asserting nothing.
 */
function helpersThatAssert(sf: ts.SourceFile, abs: string): Set<string> {
  const out = new Set<string>();
  for (const [name, body] of functionBodies(sf)) if (containsAssertion(body)) out.add(name);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;
    const target = resolveModule(path.dirname(abs), spec);
    const named = st.importClause?.namedBindings;
    if (!target || !named || !ts.isNamedImports(named)) continue;
    const bodies = functionBodies(parse(target));
    for (const el of named.elements) {
      const body = bodies.get((el.propertyName ?? el.name).text);
      if (body && containsAssertion(body)) out.add(el.name.text);
    }
  }
  return out;
}

function functionBodies(sf: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) out.set(st.name.text, st.body);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          out.set(d.name.text, init.body);
        }
      }
    }
  }
  return out;
}

function resolveModule(dir: string, spec: string): string | null {
  const base = path.resolve(dir, spec);
  const stem = base.replace(/\.[cm]?js$/, "");
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.js`, `${stem}.mjs`, path.join(base, "index.ts"), path.join(base, "index.js")];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

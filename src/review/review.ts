import * as path from "node:path";
/**
 * The `review` tool: check test scripts — the tester's own or a colleague's —
 * against the review rules, and answer in the three-part format.
 *
 * Two sources, one report: eslint-plugin-playwright's rules for the problems
 * it already knows (eslint.ts), and Proofwright's own checks for the rest
 * (check.ts). Every finding says which one found it.
 */
import { type Answer, count } from "../answer.js";
import { collectFiles, type Project } from "../project.js";
import { analyzeFile, type Finding, finding, type TestSpan, usesPlaywright } from "./check.js";
import { lintWithPlugin, PLUGIN_RULES } from "./eslint.js";
import { RULES, type RuleId, SEVERITY_ORDER, type Severity } from "./rules.js";

/** Playwright test files: *.spec.ts, *.test.js and the like. */
const TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;
/** Any script, for files named explicitly. */
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;

export interface ReviewData {
  files: string[];
  ignored: string[];
  /** Test files that don't use Playwright (Jest, Vitest, node:test …), left out. */
  notPlaywright: string[];
  /** Files the plugin couldn't parse; Proofwright's own checks still ran on them. */
  unreadable: Array<{ file: string; error: string }>;
  tests: number;
  findings: Finding[];
  counts: Record<Severity, number>;
}

/**
 * Review the given files or folders (project-relative). Folders contribute
 * their test files; a file named directly is reviewed whatever its name.
 */
export function review(project: Project, paths: string[]): Answer<ReviewData> {
  const inputs = paths.length > 0 ? paths : ["."];
  const explicit = new Set(inputs.map((p) => project.relative(project.resolve(p))));
  const collected = collectFiles(project, inputs, (rel) =>
    explicit.has(rel) ? SCRIPT_FILE.test(rel) : TEST_FILE.test(rel),
  );
  const { ignored } = collected;
  const files = collected.files.filter((rel) => usesPlaywright(project.resolve(rel)));
  const notPlaywright = collected.files.filter((rel) => !files.includes(rel));

  let tests = 0;
  const findings: Finding[] = [];
  const unreadable: ReviewData["unreadable"] = [];
  for (const rel of files) {
    const analysis = analyzeFile(project.resolve(rel), rel);
    tests += analysis.tests.length;
    const merged = [...analysis.findings];
    const plugin = lintWithPlugin(rel, analysis.text, analysis.assertingHelpers);
    if (plugin.error) unreadable.push({ file: rel, error: plugin.error });
    for (const pf of plugin.findings) {
      const test = innermostTest(analysis.tests, pf.line);
      // A skipped test also "has no assertion"; the skip is the finding that matters.
      if (pf.rule === "no-assertion" && test?.skipped) continue;
      merged.push(finding(pf.rule, rel, pf.line, analysis.lines, test?.title, pf.message, pf.source));
    }
    findings.push(...group(merged));
  }
  const counts = { high: 0, medium: 0, low: 0 } as Record<Severity, number>;
  for (const f of findings) counts[f.severity]++;

  const data: ReviewData = { files, ignored, notPlaywright, unreadable, tests, findings, counts };
  const own = Object.values(RULES).filter((r) => r.checkedBy === "Proofwright").length;
  const viaPlugin = new Set(Object.values(PLUGIN_RULES)).size;
  return {
    headline: headline(data),
    did: [
      `Read ${count(files.length, "test file")} (${count(tests, "test")}) under ${inputs.map((p) => `\`${p}\``).join(", ")} and checked them against ${Object.keys(RULES).length} rules (${viaPlugin} from eslint-plugin-playwright, ${own} of Proofwright's own). Nothing was run or changed.`,
      ...(ignored.length > 0
        ? [`Left out ${ignored.map((p) => `\`${p}\``).join(", ")}: proofwright/config.json keeps it off limits.`]
        : []),
      ...(notPlaywright.length > 0
        ? [`Left out ${count(notPlaywright.length, "test file")} that don't use Playwright: ${notPlaywright.map((p) => `\`${p}\``).join(", ")}.`]
        : []),
      ...unreadable.map((u) => `Couldn't parse \`${u.file}\` for eslint-plugin-playwright (${u.error}); Proofwright's own checks still ran on it.`),
    ],
    found: renderFindings(data),
    need:
      findings.length > 0
        ? ["Fix them in the tests, or send this list to the tests' author. I can fix them one at a time too: I'll show each change before making it."]
        : [],
    ...(files.length > 0 ? { next: 'prove the tests can fail (it takes a few minutes) — say "prove the tests".' } : {}),
    data,
  };
}

function innermostTest(tests: TestSpan[], line: number): TestSpan | undefined {
  return tests
    .filter((t) => t.start <= line && line <= t.end)
    .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
}

/**
 * One finding per rule per test for the rules that repeat line after line
 * (fragile selectors, fixed passwords), and one per line for everything else —
 * so two checks that report the same problem don't report it twice.
 */
function group(findings: Finding[]): Finding[] {
  const perTest = new Set<RuleId>(["fragile-selector", "secret-in-test"]);
  const byKey = new Map<string, Finding>();
  const out: Finding[] = [];
  for (const f of [...findings].sort((a, b) => a.line - b.line)) {
    const key = perTest.has(f.rule) && f.test ? `${f.rule}|test:${f.test}` : `${f.rule}|line:${f.line}`;
    const g = byKey.get(key);
    if (!g) {
      const copy = { ...f, lines: [...f.lines] };
      byKey.set(key, copy);
      out.push(copy);
      continue;
    }
    if (!g.lines.includes(f.line)) g.lines.push(f.line);
    if (f.detail && !g.detail?.includes(f.detail)) g.detail = g.detail ? `${g.detail} ${f.detail}` : f.detail;
    if (!g.source.split(", ").includes(f.source)) g.source = `${g.source}, ${f.source}`;
  }
  return out.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Rules whose detail only restates the title. */
const QUIET_DETAIL = new Set<RuleId>(["fragile-selector", "secret-in-test", "no-assertion", "unawaited-expect", "fixed-wait", "forced-action", "focused-test", "skipped-test"]);

/** Severity, in words that say what to do. */
const URGENCY: Record<Severity, string> = { high: "must fix", medium: "should fix", low: "could fix" };

function headline(d: ReviewData): string {
  if (d.files.length === 0) return "No test files found there.";
  if (d.findings.length === 0) return `${count(d.files.length, "test file")} reviewed: no problems found.`;
  const parts = SEVERITY_ORDER.filter((s) => d.counts[s] > 0).map((s) => `${d.counts[s]} ${URGENCY[s]}`);
  return `${count(d.findings.length, "problem")} in ${count(new Set(d.findings.map((f) => f.file)).size, "file")}: ${parts.join(", ")}.`;
}

function renderFindings(d: ReviewData): string {
  if (d.files.length === 0) return "There are no Playwright test files (`*.spec.ts`, `*.test.ts`, …) in those paths.";
  if (d.findings.length === 0) return "Every rule held in every file.";
  const out: string[] = ["| Where | Problem | What to do |", "|---|---|---|"];
  const clean = d.files.filter((f) => !d.findings.some((x) => x.file === f));
  const order = [...d.findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.file.localeCompare(b.file) || a.line - b.line);
  for (const f of order) {
    const also = f.lines.length > 1 ? ` (also ${f.lines.filter((l) => l !== f.line).join(", ")})` : "";
    const rule = RULES[f.rule];
    // Only details that add something: which value two tests share, what the retries hide.
    // The plugin's own messages and the per-line selector notes only restate the problem.
    const adds = f.detail && !f.source.includes("eslint-plugin-playwright") && !QUIET_DETAIL.has(f.rule);
    const what = `${URGENCY[f.severity] === "must fix" ? "**Must fix:** " : ""}${rule.title}${adds ? `. ${f.detail}` : ""}`;
    out.push(`| [${path.basename(f.file)}:${f.line}](${f.file}:${f.line})${also} | ${esc(what)} | ${esc(rule.fix)} |`);
  }
  const rules = [...new Set(order.map((f) => f.rule))];
  // Who found each: once per rule, not on every row.
  const foundBy = (r: RuleId) => sourceLabel([...new Set(order.filter((f) => f.rule === r).flatMap((f) => f.source.split(", ")))].join(", "));
  out.push("", "**Why these matter**", ...rules.map((r) => `- ${RULES[r].title} (found by ${foundBy(r)}): ${RULES[r].why}`));
  if (clean.length > 0) out.push("", `No problems in ${clean.map((f) => `\`${f}\``).join(", ")}.`);
  return out.join("\n");
}

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function sourceLabel(source: string): string {
  return source
    .split(", ")
    .map((s) => (s.startsWith("eslint-plugin-playwright/") ? `eslint-plugin-playwright \`${s.split("/")[1]}\`` : "Proofwright"))
    .filter((s, i, all) => all.indexOf(s) === i)
    .join(" and ");
}

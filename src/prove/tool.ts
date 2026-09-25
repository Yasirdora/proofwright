/**
 * The `prove` tool: a proof (prove.ts), told to the tester short and clear —
 * what needs a better check, what can't be checked yet, what's good, and what
 * to do — with the full details in a page in proofwright/reports/ that can be
 * shared with developers.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Answer, count } from "../answer.js";
import type { Project } from "../project.js";
import { type Proof, prove, type ProveOptions } from "./prove.js";
import { type Cell, FAULT_PHRASE, type ProvenTest, type Verdict } from "./verdict.js";

export type ProveInput = Omit<ProveOptions, "progress">;

/** What the answer carries for machines: small — the whole proof is in `proofFile`. */
export interface ProveData {
  id: string;
  reportFile: string;
  proofFile: string;
  counts: Record<Verdict, number>;
  tests: Array<{
    title: string;
    file: string;
    line: number;
    verdict: Verdict;
    result: string;
    todo: string;
    slow?: string;
    evidence?: { screenshot?: string; trace?: string };
  }>;
  stopped?: Proof["stopped"];
  unmatched: string[];
}

const MARK: Record<Verdict, string> = {
  "misses its own action": "❌",
  "can't fail": "❌",
  "not proven": "⚠️",
  catches: "✅",
};
const ORDER: Verdict[] = ["misses its own action", "can't fail", "not proven", "catches"];
/** Good tests are listed by name up to this many; above it, counted. */
const LIST_GOOD = 6;

export async function proveTool(project: Project, input: ProveInput, progress?: ProveOptions["progress"]): Promise<Answer<ProveData>> {
  const proof = await prove(project, { ...input, ...(progress ? { progress } : {}) });
  const reportFile = project.relative(project.stateFile("reports", `proof-${proof.id}.md`));
  const sorted = [...proof.tests].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) || a.file.localeCompare(b.file) || a.line - b.line);

  const headline = proof.stopped
    ? `Stopped before breaking anything: checking ${count(proof.clean.tests, "test")} needs ${proof.stopped.needed} runs, more than the limit of ${proof.stopped.maxRuns}.`
    : noCalls(proof)
      ? `Prove can't check ${proof.tests.length === 1 ? "this test" : "these tests"}: the app made no server calls.`
      : `${count(proof.tests.length, "test")} checked: ${tally(proof.tests)}.`;
  const did = whatIDid(proof, reportFile);
  const found = proof.stopped ? callsFound(proof) : shortTable(proof, sorted, reportFile);
  const need = whatToDo(proof);
  fs.writeFileSync(path.join(project.root, reportFile), fullReport(proof, sorted, headline));

  const counts = Object.fromEntries(ORDER.map((v) => [v, proof.tests.filter((t) => t.verdict === v).length])) as Record<Verdict, number>;
  return {
    headline,
    did,
    found,
    need,
    ...(proof.stopped ? {} : { next: nextStep(proof.tests) }),
    data: {
      id: proof.id,
      reportFile,
      proofFile: `${proof.dir}/proof.json`,
      counts,
      tests: sorted.map((t) => ({
        title: t.title,
        file: t.file,
        line: t.line,
        verdict: t.verdict,
        result: t.result,
        todo: t.todo,
        ...(slowNote(proof, t) ? { slow: slowNote(proof, t) } : {}),
        ...(evidenceOf(t) ? { evidence: evidenceOf(t) } : {}),
      })),
      ...(proof.stopped ? { stopped: proof.stopped } : {}),
      unmatched: proof.unmatched,
    },
  };
}

/** The session's next step after a proof, and what to say. */
function nextStep(tests: ProvenTest[]): string {
  const weak = tests.filter((t) => t.verdict === "misses its own action" || t.verdict === "can't fail").length;
  const failing = tests.filter((t) => t.verdict === "not proven" && /already fails with nothing broken/.test(t.result)).length;
  if (weak > 0) return `make the ${weak === 1 ? "test" : `${weak} tests`} marked ❌ check what ${weak === 1 ? "its" : "their"} own step did — say "fix the tests prove flagged", and I'll show each change first.`;
  if (failing > 0) return `find out why ${failing === 1 ? "a test fails" : `${failing} tests fail`} with nothing broken — say "explain the failing tests" for the reasons and bug reports.`;
  return "test something else — `/proofwright <what to test>`.";
}

function tally(tests: ProvenTest[]): string {
  const bad = tests.filter((t) => t.verdict === "misses its own action" || t.verdict === "can't fail").length;
  const good = tests.filter((t) => t.verdict === "catches").length;
  const unchecked = tests.filter((t) => t.verdict === "not proven").length;
  return [
    ...(bad > 0 ? [`${bad} ${bad === 1 ? "needs" : "need"} a better check`] : []),
    ...(good > 0 ? [`${good} ${good === 1 ? "is" : "are"} good`] : []),
    ...(unchecked > 0 ? [`${unchecked} can't be checked yet`] : []),
  ].join(", ");
}

function seconds(ms: number): string {
  if (ms >= 90_000) return `${(ms / 60_000).toFixed(1)} min`;
  return ms % 1000 === 0 || ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The screenshot and trace behind a ❌: the page the test passed on while its own step was broken. */
function evidenceOf(t: ProvenTest): Cell["evidence"] | undefined {
  if (t.verdict !== "misses its own action" && t.verdict !== "can't fail") return undefined;
  const actions = new Set(t.calls.filter((c) => c.action).map((c) => c.endpoint));
  const behind = (c: Cell) => c.evidence && c.endpoint !== undefined && actions.has(c.endpoint) && (c.kind === "error" || c.kind === "changed");
  return (t.missed.find(behind) ?? t.missed.find((c) => c.evidence))?.evidence;
}

/** A ✅ or ❌ test that fails when every answer only comes late: a fixed wait or a short timeout. */
function slowNote(proof: Proof, t: ProvenTest): string | undefined {
  if (t.verdict === "not proven" || t.slow?.outcome !== "caught") return undefined;
  return `Fails when every answer comes ${seconds(proof.slowMs)} late${t.slow.errorAt ? ` (at ${path.basename(t.slow.errorAt)})` : ""}: look there for a fixed wait or a short timeout.`;
}

/** The app made no server calls while the tests ran: prove had nothing to break. */
const noCalls = (proof: Proof) => proof.clean.calls === 0 && proof.tests.length > 0;
const NO_CALLS_RESULT = /^Not checked: the app made no server calls/;
const NO_CALLS_NOTE = (tests: number) =>
  `Prove checks a test by breaking the app's calls to its server and seeing whether the test notices. While your ${count(tests, "test")} ran, the app made no such calls — it works in the browser, or the tests never reached its server — so there was nothing to break. This says nothing against the tests; prove can't check an app like this yet.`;

function shortTable(proof: Proof, sorted: ProvenTest[], reportFile: string): string {
  const out: string[] = [];
  if (noCalls(proof)) out.push(NO_CALLS_NOTE(proof.clean.tests), "");
  // With no calls, a test that simply wasn't checked needs no row: the note says it for all of them.
  const attention = sorted.filter((t) => (t.verdict !== "catches" || slowNote(proof, t)) && !NO_CALLS_RESULT.test(t.result));
  if (attention.length > 0) {
    out.push("| Test | Result | What to do |", "|---|---|---|");
    for (const t of attention) {
      const ev = evidenceOf(t);
      const slow = slowNote(proof, t);
      const result = t.verdict === "catches" ? `⏱ ${slow}` : `${MARK[t.verdict]} ${t.result}${slow ? ` ⏱ ${slow}` : ""}`;
      const todo = [t.todo || "—", ...(ev?.screenshot ? [`[screenshot](${ev.screenshot})`] : [])].join(" ");
      out.push(`| [${esc(t.title)}](${t.file}:${t.line}) | ${esc(result)} | ${esc(todo)} |`);
    }
    out.push("");
  }
  const good = sorted.filter((t) => t.verdict === "catches");
  if (good.length > 0) {
    out.push(
      good.length <= LIST_GOOD
        ? `✅ Good — they fail when their own steps fail: ${good.map((t) => `"${t.title}"`).join(", ")}.`
        : `✅ ${good.length} tests are good: they fail when their own steps fail.`,
    );
  }
  const couldnt = [...proof.https.passedThrough, ...proof.https.untrusted];
  if (couldnt.length > 0) out.push("", `Not broken: calls to ${couldnt.join(", ")} (see the report).`);
  out.push("", `Details for each test, and how it was checked: \`${reportFile}\`.`);
  return out.join("\n");
}

function callsFound(proof: Proof): string {
  const out = [`**What your tests call** (${count(proof.endpoints.length, "endpoint")}):`];
  for (const e of proof.endpoints) out.push(`- \`${e.name}\`${e.action ? " (changes something)" : ""}: ${count(e.tests.length, "test")}`);
  return out.join("\n");
}

function whatToDo(proof: Proof): string[] {
  const need: string[] = [];
  if (proof.stopped) {
    const first = proof.endpoints.find((e) => e.action) ?? proof.endpoints[0];
    need.push(
      `Checking these tests needs ${proof.stopped.needed} runs (more than the limit of ${proof.stopped.maxRuns}). Name the calls to break${first ? ` (for example endpoints: ["${first.name}"])` : ""}, name fewer tests, or allow more runs (maxRuns: ${proof.stopped.needed}).`,
    );
  }
  for (const f of proof.unmatched) need.push(`No call matched "${f}".`);
  if (proof.stopped) return need;
  const todo = proof.tests.filter((t) => t.todo);
  if (todo.length > 0) need.push("Do what the table says for each test. I haven't changed any test; I can make a change for you, after showing it to you.");
  if (proof.https.untrusted.length > 0) {
    need.push(`The certificate of ${proof.https.untrusted.join(", ")} couldn't be checked, so those calls failed. If it's a test certificate, set \`ignoreHTTPSErrors: true\` in your Playwright config and prove again.`);
  }
  return need;
}

function whatIDid(proof: Proof, reportFile: string): string[] {
  const perCall = proof.runs.filter((r) => r.kind !== "slow" && !r.test).length;
  const repeats = proof.runs.filter((r) => r.test).length;
  return [
    `Ran ${proof.selection.length > 0 ? `\`npx playwright test ${proof.selection.join(" ")}\`` : "your tests"} once with nothing broken (${count(proof.clean.tests, "test")}, ${seconds(proof.clean.durationMs)})${
      proof.stopped
        ? ", then stopped."
        : proof.runs.length === 0
          ? ", and stopped there: there was nothing to break."
        : `, then ${count(proof.runs.length, "more time")} with something broken: one call at a time (${perCall})${repeats > 0 ? `, a repeated step (${repeats})` : ""}${proof.runs.some((r) => r.kind === "slow") ? ", every answer late (1)" : ""} — ${seconds(proof.runs.reduce((n, r) => n + r.durationMs, 0))}.`
    }`,
    ...(proof.cleanRun ? [`Kept the run with nothing broken as run ${proof.cleanRun}, so explain can read its failures.`] : []),
    `Your tests and config weren't changed. Full details: \`${reportFile}\`.`,
  ];
}

// ---------------------------------------------------------------- the page for developers

function fullReport(proof: Proof, sorted: ProvenTest[], headline: string): string {
  const out: string[] = [`# Proof — ${proof.id}`, "", `**${headline}**`, "", ...(noCalls(proof) ? [NO_CALLS_NOTE(proof.clean.tests), ""] : [])];
  if (proof.stopped) {
    out.push(callsFound(proof), "");
    return `${out.join("\n")}\n`;
  }
  out.push("| Test | Result | What to do |", "|---|---|---|");
  for (const t of sorted) {
    const slow = slowNote(proof, t);
    out.push(`| [${esc(t.title)}](${t.file}:${t.line}) | ${MARK[t.verdict]} ${esc(t.result)}${slow ? ` ⏱ ${esc(slow)}` : ""} | ${esc(t.todo || "—")} |`);
  }
  out.push("", "## What each test noticed", "");
  const names = (cells: Cell[]) => [...new Set(cells.map((c) => `${c.endpoint ? proof.endpoints.find((e) => e.endpoint === c.endpoint)?.name ?? c.endpoint : "every call"}${c.nth ? ` (call ${c.nth})` : ""} ${FAULT_PHRASE[c.kind]}`))].join("; ");
  for (const t of sorted.filter((x) => x.caught.length + x.missed.length + x.notTried.length > 0)) {
    out.push(`**${t.title}**`);
    if (t.caught.length > 0) out.push(`- Failed (good) when: ${names(t.caught)}`);
    if (t.missed.length > 0) out.push(`- Still passed when: ${names(t.missed)}`);
    if (t.notTried.length > 0) out.push(`- Didn't run when: ${names(t.notTried)}`);
    const ev = t.missed.filter((c) => c.evidence);
    for (const c of ev) {
      out.push(`- Evidence (${names([c])}): ${[c.evidence?.screenshot ? `[screenshot](${c.evidence.screenshot})` : "", c.evidence?.trace ? `trace: \`npx playwright show-trace ${c.evidence.trace}\`` : ""].filter(Boolean).join(" · ")}`);
    }
    out.push("");
  }
  out.push("## How it was checked", "");
  out.push(
    `- A temporary config (\`${proof.wrapper}\`) loaded \`${proof.config}\` unchanged and sent the browser's traffic through Proofwright's local proxy, which broke API calls on purpose. It was deleted afterwards${proof.leftoverRemoved ? ", with one an interrupted proof had left" : ""}.`,
    `- The clean run: ${count(proof.clean.tests, "test")}${proof.clean.skipped > 0 ? ` (${proof.clean.skipped} skipped)` : ""}, one at a time, ${count(proof.clean.calls, "API call")} to ${count(proof.endpoints.length, "endpoint")}, ${seconds(proof.clean.durationMs)}.`,
    ...proof.runs.map((r) => `- ${r.label} — ${seconds(r.durationMs)}${r.problem ? ` (no results: ${r.problem})` : ""}`),
    ...(proof.faultTimeoutMs ? [`- A test stuck on a broken page was stopped after ${seconds(proof.faultTimeoutMs)} (the slowest clean test took ${seconds(proof.longestTestMs)}).`] : []),
    ...(proof.https.opened.length > 0 ? [`- HTTPS calls to ${proof.https.opened.join(", ")} were opened with a certificate made for the proof; the proxy checked each site's real certificate.`] : []),
    ...(proof.https.passedThrough.length > 0 ? [`- HTTPS calls to ${proof.https.passedThrough.join(", ")} passed through unbroken: openssl isn't there to make a certificate.`] : []),
    "",
  );
  return out.join("\n");
}

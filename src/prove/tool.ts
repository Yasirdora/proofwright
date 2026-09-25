/**
 * The `prove` tool: a proof (prove.ts), told to the tester — which tests
 * notice when the app breaks, which pass anyway, and the evidence — and kept
 * as a page in proofwright/reports/.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Answer, count } from "../answer.js";
import type { Project } from "../project.js";
import { type Proof, prove, type ProveOptions } from "./prove.js";
import { type Cell, FAULT_PHRASE, type ProvenTest, type Verdict } from "./verdict.js";

export type ProveInput = Omit<ProveOptions, "progress">;

export interface ProveData extends Proof {
  reportFile: string;
}

const MARK: Record<Verdict, string> = {
  "passes when its own action fails": "❌ Passes when its own action fails",
  "can't fail": "❌ Can't fail",
  "not proven": "⚠️ Not proven",
  catches: "✅ Catches",
};
const ORDER: Verdict[] = ["passes when its own action fails", "can't fail", "not proven", "catches"];

export async function proveTool(project: Project, input: ProveInput, progress?: ProveOptions["progress"]): Promise<Answer<ProveData>> {
  const proof = await prove(project, { ...input, ...(progress ? { progress } : {}) });
  const name = (endpoint: string) => proof.endpoints.find((e) => e.endpoint === endpoint)?.name ?? endpoint;
  const reportFile = project.relative(project.stateFile("reports", `proof-${proof.id}.md`));

  const headline = proof.stopped
    ? `Stopped before breaking anything: proving ${count(proof.clean.tests, "test")} needs ${proof.stopped.needed} runs, more than the limit of ${proof.stopped.maxRuns}.`
    : `${count(proof.tests.length, "test")}: ${tally(proof.tests)}.`;
  const did = whatIDid(proof, reportFile);
  const found = whatIFound(proof, name);
  const need = whatINeed(proof, name);
  fs.writeFileSync(
    path.join(project.root, reportFile),
    `# Proof — ${proof.id}\n\n**${headline}**\n\n## What I did\n${did.map((d) => `- ${d}`).join("\n")}\n\n## What I found\n${found}\n`,
  );
  return {
    headline,
    did,
    found,
    need,
    next: "Every test noticed its own calls failing.",
    data: { ...proof, reportFile },
  };
}

function tally(tests: ProvenTest[]): string {
  const n = (v: Verdict) => tests.filter((t) => t.verdict === v).length;
  const parts: string[] = [];
  const pw = n("passes when its own action fails");
  if (pw) parts.push(pw === 1 ? "1 passes when its own action fails" : `${pw} pass when their own action fails`);
  if (n("can't fail")) parts.push(`${n("can't fail")} can't fail`);
  if (n("catches")) parts.push(n("catches") === 1 ? "1 catches what breaks" : `${n("catches")} catch what breaks`);
  if (n("not proven")) parts.push(`${n("not proven")} not proven`);
  return parts.join(", ");
}

function seconds(ms: number): string {
  if (ms >= 90_000) return `${(ms / 60_000).toFixed(1)} min`;
  return ms % 1000 === 0 || ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;
}

function whatIDid(proof: Proof, reportFile: string): string[] {
  const did: string[] = [
    `Wrote \`${proof.wrapper}\` beside \`${proof.config}\` for the proof: it loads your config unchanged and sends the browser's traffic through Proofwright's local proxy. It's deleted now${proof.leftoverRemoved ? ", along with one an interrupted proof had left" : ""}; your tests, your config and test-results/ weren't changed.`,
    `Ran ${proof.selection.length > 0 ? `\`npx playwright test ${proof.selection.join(" ")}\`` : "all your tests"} once with nothing broken, one test at a time: ${count(proof.clean.tests, "test")}${proof.clean.skipped > 0 ? ` (and ${proof.clean.skipped} skipped, which a proof can't prove)` : ""}, ${count(proof.clean.calls, "API call")} to ${count(proof.endpoints.length, "endpoint")}, in ${seconds(proof.clean.durationMs)}.`,
  ];
  if (proof.stopped) {
    did.push(`Stopped there: breaking each of those calls would take ${proof.stopped.needed} runs.`);
  } else if (proof.runs.length > 0) {
    const kinds = proof.faults.filter((k) => k !== "slow").map((k) => ({ error: "a server error", empty: "empty lists (for answers that hold lists)", malformed: "broken data", slow: "" })[k]);
    const perCall = proof.runs.filter((r) => r.kind !== "slow").length;
    const slow = proof.runs.some((r) => r.kind === "slow");
    did.push(
      `Broke one call at a time, ${count(perCall, "run")} — ${kinds.join(", ")}${slow ? ` — and made one run with every answer ${seconds(proof.slowMs)} late` : ""}; each run took only the files whose tests make that call. ${count(proof.runs.length, "run")} in ${seconds(proof.runs.reduce((n, r) => n + r.durationMs, 0))}.`,
    );
    if (proof.faultTimeoutMs) {
      did.push(`Stopped a test stuck on a broken page after ${seconds(proof.faultTimeoutMs)} (with nothing broken, your slowest test took ${seconds(proof.longestTestMs)}).`);
    }
  }
  for (const r of proof.runs.filter((x) => x.problem)) did.push(`The run where ${r.label} gave no results (${r.problem}); its tests count as not tried.`);
  if (proof.https.opened.length > 0) {
    did.push(`Opened the HTTPS calls to ${proof.https.opened.join(", ")} with a certificate made for this proof; the browser accepted it for the proof only, and the proxy checked each site's real certificate instead.`);
  }
  if (proof.https.passedThrough.length > 0) {
    did.push(`Couldn't break the HTTPS calls to ${proof.https.passedThrough.join(", ")}: they passed through untouched, because openssl isn't there to make a certificate.`);
  }
  if (proof.https.untrusted.length > 0) {
    did.push(`Couldn't verify the certificate of ${proof.https.untrusted.join(", ")}, so those calls failed. If that site uses a test certificate, set \`ignoreHTTPSErrors: true\` in your config and prove again.`);
  }
  const kept = proof.tests.some((t) => [...t.missed, ...(t.slow ? [t.slow] : [])].some((c) => c.evidence));
  did.push(`${kept ? `Kept a screenshot and a trace of each run where a test passed while its own call was broken, in \`${proof.dir}/\`; w` : "W"}rote this page to \`${reportFile}\`.`);
  return did;
}

function names(cells: Cell[], name: (e: string) => string, max = 6): string {
  const all = [...new Set(cells.map((c) => `${c.endpoint ? name(c.endpoint) : "every call"} ${FAULT_PHRASE[c.kind]}`))];
  return all.slice(0, max).join("; ") + (all.length > max ? `; and ${all.length - max} more` : "");
}

/** The evidence behind a verdict: the page a test passed on while its own call was broken. */
function evidenceLinks(t: ProvenTest): string {
  const behind =
    t.verdict === "passes when its own action fails"
      ? t.missed.filter((c) => c.kind === "error" && t.calls.some((k) => k.action && k.endpoint === c.endpoint))
      : t.verdict === "can't fail"
        ? t.missed
        : [];
  const cell = behind.find((c) => c.evidence);
  if (!cell?.evidence) return "—";
  return [
    cell.evidence.screenshot ? `[screenshot](${cell.evidence.screenshot})` : "",
    cell.evidence.trace ? `trace: \`npx playwright show-trace ${cell.evidence.trace}\`` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function whatIFound(proof: Proof, name: (e: string) => string): string {
  const out: string[] = [];
  if (proof.clean.calls === 0) {
    out.push(
      "**The proxy saw no API calls at all.** These tests may not use a browser or Playwright's request fixture — or the browser didn't use the proxy (measured on Chromium; Firefox and WebKit aren't yet).",
      "",
    );
  }
  if (proof.stopped) {
    out.push(`**What your tests call** (${count(proof.endpoints.length, "endpoint")}):`);
    for (const e of proof.endpoints) {
      const who = proof.tests.filter((t) => e.tests.includes(t.id)).map((t) => `"${t.title}"`);
      out.push(`- \`${e.name}\`${e.action ? " (changes something)" : ""} — ${who.slice(0, 4).join(", ")}${who.length > 4 ? ` and ${who.length - 4} more` : ""}`);
    }
    return out.join("\n");
  }
  const sorted = [...proof.tests].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) || a.file.localeCompare(b.file) || a.line - b.line);
  out.push("| Test | Verdict | Why | Evidence |", "|---|---|---|---|");
  for (const t of sorted) {
    out.push(`| [${esc(t.title)}](${t.file}:${t.line}) | ${MARK[t.verdict]} | ${esc(t.reason)} | ${evidenceLinks(t)} |`);
  }
  out.push("");

  const detailed = sorted.filter((t) => t.caught.length + t.missed.length + t.notTried.length > 0);
  if (detailed.length > 0) {
    out.push("**What each test noticed**");
    for (const t of detailed) {
      const parts = [
        t.caught.length > 0 ? `failed when ${names(t.caught, name)}` : "",
        t.missed.length > 0 ? `passed anyway when ${names(t.missed, name)}` : "",
        t.notTried.length > 0 ? `didn't run when ${names(t.notTried, name)}` : "",
      ].filter(Boolean);
      out.push(`- **${t.title}** — ${parts.join(" · ")}`);
    }
    out.push("");
  }

  const late = sorted.filter((t) => t.verdict !== "not proven" && t.slow?.outcome === "caught");
  if (late.length > 0) {
    out.push(`**When every answer came ${seconds(proof.slowMs)} late**, ${late.length === 1 ? "one test" : `${late.length} tests`} failed — the app still worked, only slower:`);
    for (const t of late) out.push(`- **${t.title}**${t.slow?.errorAt ? ` at [${t.slow.errorAt}](${t.slow.errorAt})` : ""}${t.slow?.error ? `: ${t.slow.error}` : ""}`);
    out.push("");
  }
  return out.join("\n").trim();
}

function whatINeed(proof: Proof, name: (e: string) => string): string[] {
  const need: string[] = [];
  if (proof.stopped) {
    const first = proof.endpoints.find((e) => e.action) ?? proof.endpoints[0];
    need.push(
      `Proving these tests needs ${proof.stopped.needed} runs, more than the limit of ${proof.stopped.maxRuns}. Name the calls to break${first ? ` — e.g. endpoints: ["${first.name}"]` : ""} — or fewer tests, or allow more runs (maxRuns: ${proof.stopped.needed}).`,
    );
  }
  for (const f of proof.unmatched) need.push(`No call matched "${f}" — the calls your tests make are listed above.`);
  if (proof.stopped) return need;

  for (const t of proof.tests.filter((x) => x.verdict === "passes when its own action fails")) {
    const actions = [...new Set(t.missed.filter((c) => c.kind === "error" && c.endpoint && t.calls.some((k) => k.action && k.endpoint === c.endpoint)).map((c) => name(c.endpoint!)))];
    need.push(
      `"${t.title}" (${t.file}:${t.line}): make it check that ${actions.join(" and ")} worked — something the page shows only when it did. The screenshot shows the page it passed on. I haven't changed the test.`,
    );
  }
  for (const t of proof.tests.filter((x) => x.verdict === "can't fail")) {
    need.push(`"${t.title}" (${t.file}:${t.line}): it checks nothing the app's answers change — add an assertion on what the page shows. I haven't changed the test.`);
  }
  const unproven = proof.tests.filter((x) => x.verdict === "not proven" && /flaky|nothing broken/.test(x.reason));
  if (unproven.length > 0) {
    need.push(`Fix ${unproven.map((t) => `"${t.title}"`).join(", ")} first (${unproven.length === 1 ? "the reason is" : "the reasons are"} in the table), then prove ${unproven.length === 1 ? "it" : "them"} again.`);
  }
  for (const t of proof.tests.filter((x) => x.verdict !== "not proven" && x.slow?.outcome === "caught")) {
    need.push(`"${t.title}" failed when answers came ${seconds(proof.slowMs)} late${t.slow?.errorAt ? `, at ${t.slow.errorAt}` : ""}: look there for a fixed wait or a short timeout.`);
  }
  return need;
}

/**
 * Why a test failed — app bug, test bug, flaky, or environment — decided by
 * fixed rules from the evidence Playwright kept, with the reasoning and how
 * sure it is. The strongest evidence decides first: a retry that passed, an
 * unreachable server, the test's own code throwing, an ambiguous locator;
 * then what the page looked like when a locator found nothing, and a value
 * the page showed that the test didn't expect.
 *
 * It proposes; it never changes a test, and it never proposes changing what a
 * test expects in order to make it pass.
 */
import type { RunTest } from "./runs.js";

export type Kind = "app bug" | "test bug" | "app or test" | "flaky" | "environment" | "unclear";
export type Confidence = "certain" | "likely" | "possible";

export interface Diagnosis {
  kind: Kind;
  confidence: Confidence;
  /** One line, for the report. */
  summary: string;
  /** How the evidence led there. */
  reasoning: string[];
  /** What to do next — never "change what the test expects". */
  proposal: string;
  expected?: string;
  received?: string;
}

export interface ClassifyContext {
  /** The page's accessibility snapshot when the test failed (from error-context.md). */
  snapshot?: string;
  /** This test's status in earlier runs, oldest first, with the code version. */
  history?: Array<{ status: string; head?: string }>;
  /** The code version of this run. */
  head?: string;
  /** Set when the test's title names an approved test case. */
  approvedCase?: boolean;
}

const ENVIRONMENT: Array<[RegExp, string]> = [
  [/net::ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/, "the address doesn't resolve — the name isn't known to this machine's DNS"],
  [/net::ERR_CONNECTION_REFUSED|ECONNREFUSED/, "nothing is listening at the address — the server isn't running there"],
  [/net::ERR_(CONNECTION_RESET|CONNECTION_CLOSED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|TIMED_OUT|NETWORK_CHANGED)/, "the network connection to the server failed"],
  [/net::ERR_CERT_|SSL routines/, "the server's certificate isn't accepted"],
  [/Executable doesn't exist|browserType\.launch|Looks like Playwright .* just installed/, "the browser couldn't start — it may not be installed for this Playwright version"],
  [/config\.webServer|webServer/, "the app's web server (webServer in playwright.config) didn't start"],
];

export function classify(test: RunTest, ctx: ClassifyContext = {}): Diagnosis {
  const message = test.error?.message ?? "";
  const first = message.split("\n")[0] ?? "";
  const { expected, received } = expectedReceived(message);
  const values = { ...(expected !== undefined ? { expected } : {}), ...(received !== undefined ? { received } : {}) };

  if (test.status === "flaky") {
    return {
      kind: "flaky",
      confidence: "certain",
      summary: `failed, then passed on retry (${test.attempts.join(" → ")})`,
      reasoning: [
        `Attempts in this run: ${test.attempts.join(" → ")}. The same test, same code, gave different results.`,
        `The first attempt failed with: ${first}`,
      ],
      proposal:
        "Find what the first attempt waited for, and make the test wait for that state (or fix the app's timing). Retries hide it; they don't fix it.",
      ...values,
    };
  }

  for (const [pattern, why] of ENVIRONMENT) {
    if (pattern.test(message)) {
      const url = /(https?:\/\/[^\s"']+)/.exec(message)?.[1];
      return {
        kind: "environment",
        confidence: "certain",
        summary: `${why}${url ? ` (${url})` : ""}`,
        reasoning: [`Playwright reported: ${first}`, `That's about reaching the app or starting the browser, not about what the app did.`],
        proposal: `Check that ${url ?? "the app"} is up and reachable from this machine, then run again. Nothing in the test or the app needs changing for this.`,
      };
    }
  }

  const codeError = /^(TypeError|ReferenceError|SyntaxError|RangeError): (.*)$/m.exec(message);
  if (codeError && !/expect\(|locator\.|page\./.test(first)) {
    return {
      kind: "test bug",
      confidence: "certain",
      summary: `the test's own code threw: ${codeError[1]}: ${codeError[2]}`,
      reasoning: [
        `A ${codeError[1]} comes from the test's code${test.error?.line ? ` (${test.error.file}:${test.error.line})` : ""}, not from a check on the page.`,
        "The app wasn't judged at all.",
      ],
      proposal: "Fix the test's code at that line — it assumed something the page didn't give it (an element, a value). No expectation needs to change.",
    };
  }

  const strict = /strict mode violation: (.+?) resolved to (\d+) elements/.exec(message);
  if (strict) {
    const candidates = [...message.matchAll(/^\s*\d+\) .*? aka (.+)$/gm)].map((m) => m[1].trim()).slice(0, 3);
    return {
      kind: "test bug",
      confidence: "certain",
      summary: `the locator ${strict[1]} matches ${strict[2]} elements, so Playwright can't tell which one is meant`,
      reasoning: [
        `Playwright refuses to act on a locator that matches more than one element (strict mode); this one matched ${strict[2]}.`,
        ...(candidates.length > 0 ? [`Among them: ${candidates.join("; ")}.`] : []),
      ],
      proposal: `Name the one element the test means${candidates[0] ? `, e.g. \`${candidates[0]}\`` : ""}. I won't change the test without your yes.`,
    };
  }

  const waiting = /waiting for (getBy\w+\((?:[^()]|\([^()]*\))*\)|locator\((?:[^()]|\([^()]*\))*\))/.exec(message);
  const resolved = /locator resolved to/.test(message);
  if (waiting && !resolved && /Timeout|timed out|not found|toBeVisible|toHaveCount/i.test(message)) {
    return notFound(waiting[1], ctx, first, values);
  }

  if (expected !== undefined && received !== undefined) {
    const onPage = /^Error: expect\(locator\)|expect\(page\)/.test(first) || resolved;
    const confidence: Confidence = ctx.approvedCase ? "likely" : "possible";
    return {
      kind: "app bug",
      confidence: sameCodeEarlierPass(ctx) ? "possible" : confidence,
      summary: `${onPage ? "the page shows" : "the app gave"} ${received} where the test expects ${expected}`,
      reasoning: [
        onPage
          ? "Playwright found the element and read a different value from it — the check ran against the real page."
          : "The value came from the app (a response, a count) and differs from what the test expects.",
        ctx.approvedCase
          ? "This test comes from an approved test case, so its expected result is the one you agreed on."
          : "Whether the app or the test's expectation is wrong depends on the requirement — check it against the requirement, not against this test.",
        ...historyNote(ctx),
      ],
      proposal: ctx.approvedCase
        ? "Report it as a bug — a draft is below. Don't change the test's expectation to match the app."
        : "Check the requirement. If the app is wrong, report it (a draft is below); if the requirement really changed, change the test case first, then the test.",
      expected,
      received,
    };
  }

  if (/Test timeout of \d+ms exceeded/.test(message)) {
    return {
      kind: sameCodeEarlierPass(ctx) ? "flaky" : "unclear",
      confidence: "possible",
      summary: "the test ran out of time before it finished",
      reasoning: [`Playwright reported: ${first}`, ...historyNote(ctx), "The trace shows what it was waiting for when time ran out."],
      proposal: "Open the trace and look at the last action before the timeout; that says whether the app was slow, or the test waited for the wrong thing.",
    };
  }

  return {
    kind: "unclear",
    confidence: "possible",
    summary: first || "it failed without an error message",
    reasoning: ["None of the rules matched this failure well enough to name a cause.", ...historyNote(ctx)],
    proposal: "Open the screenshot and the trace; tell me what you see and I'll take it from there.",
    ...values,
  };
}

/**
 * A locator that found nothing: is there a similar element (a test bug), or
 * none at all — then the app didn't show it, or the test expects the wrong
 * thing or took a wrong turn, and only the requirement and the screenshot can
 * tell which. Measured: both such failures in a trial were the tests' own
 * mistakes (a panel the test never opened, a dialog the app doesn't show).
 */
function notFound(locator: string, ctx: ClassifyContext, first: string, values: object): Diagnosis {
  const want = parseLocator(locator);
  const snapshot = ctx.snapshot ?? "";
  const onPage = [...snapshot.matchAll(/^\s*- (\w+) "([^"]*)"/gm)].map((m) => ({ role: m[1], name: m[2] }));
  const sameRole = want?.role ? onPage.filter((e) => e.role === want.role) : [];
  const exact = want?.name ? sameRole.find((e) => e.name === want.name) : undefined;
  // The same kind of element with a close name — or, of any kind, a name that contains the other.
  const similar = want?.name
    ? (sameRole.find((e) => e !== exact && similarNames(e.name, want.name!)) ??
      onPage.find((e) => e.name && (e.name.toLowerCase().includes(want.name!.toLowerCase()) || want.name!.toLowerCase().includes(e.name.toLowerCase()))))
    : undefined;
  const headings = onPage.filter((e) => e.role === "heading").map((e) => `"${e.name}"`).slice(0, 3);

  if (!snapshot) {
    return {
      kind: "unclear",
      confidence: "possible",
      summary: `nothing matched ${locator}`,
      reasoning: [`Playwright reported: ${first}`, "There's no snapshot of the page to compare with."],
      proposal: "Open the screenshot: is the element there under another name (a test bug), or missing (an app bug)?",
      ...values,
    };
  }
  if (exact) {
    return {
      kind: "unclear",
      confidence: "possible",
      summary: `the ${exact.role} "${exact.name}" is on the page but couldn't be used`,
      reasoning: [
        `The page did have a ${exact.role} named "${exact.name}", yet ${locator} wasn't usable in time.`,
        "That points at an element that was hidden, covered, disabled or still moving — the app, or the test's timing.",
      ],
      proposal: "Open the trace at the failing step: it shows whether the element was covered, disabled or not yet stable.",
      ...values,
    };
  }
  if (similar) {
    const replacement = want?.role ? `getByRole('${similar.role}', { name: '${similar.name}' })` : `the ${similar.role} "${similar.name}"`;
    return {
      kind: "test bug",
      confidence: "likely",
      summary: `the test looks for ${locator}; the page has ${similar.role} "${similar.name}"`,
      reasoning: [
        `Nothing on the page matched ${locator}.`,
        `The page at that moment did have a ${similar.role} named "${similar.name}" — close to what the test asks for, so the test's locator is probably out of date.`,
        "If the name on the page is itself wrong (the requirement says otherwise), it's an app bug instead.",
      ],
      proposal: `If "${similar.name}" is the right element, the locator should be \`${replacement}\`. I won't change the test without your yes.`,
      ...values,
    };
  }
  return {
    kind: "app or test",
    confidence: "possible",
    summary: `nothing like ${locator} is on the page`,
    reasoning: [
      `Nothing on the page matched ${locator}, and nothing similar was there either.`,
      headings.length > 0 ? `The page at that moment showed ${headings.join(", ")}.` : "The snapshot shows what the page held instead.",
      "Either the app didn't show what it should (an app bug), or the test expects something the app doesn't promise, or got to a different page than it expected (a test bug) — the requirement and the screenshot tell which.",
    ],
    proposal: "Look at the screenshot. If the page should show it, say so and I'll draft the bug report; if the test expects the wrong thing or took a wrong turn, I'll propose the change to the test.",
    ...values,
  };
}

function parseLocator(locator: string): { role?: string; name?: string } | undefined {
  const role = /getByRole\('([^']+)'(?:,\s*\{[^}]*name:\s*'([^']*)')?/.exec(locator);
  if (role) return { role: role[1], name: role[2] };
  const other = /getBy(?:Label|Text|Placeholder|Title|AltText)\('([^']*)'/.exec(locator);
  if (other) return { name: other[1] };
  return undefined;
}

function similarNames(a: string, b: string): boolean {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x || !y || x === y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const words = (s: string) => new Set(s.split(/\W+/).filter((w) => w.length > 2));
  const [wx, wy] = [words(x), words(y)];
  return [...wx].some((w) => wy.has(w));
}

function expectedReceived(message: string): { expected?: string; received?: string } {
  const expected = /^\s*Expected(?: \w+)?: (.+)$/m.exec(message)?.[1]?.trim();
  const received = /^\s*Received(?: \w+)?: (.+)$/m.exec(message)?.[1]?.trim();
  return { ...(expected ? { expected } : {}), ...(received ? { received } : {}) };
}

function sameCodeEarlierPass(ctx: ClassifyContext): boolean {
  return (ctx.history ?? []).some((h) => h.status === "passed" && h.head !== undefined && h.head === ctx.head);
}

function historyNote(ctx: ClassifyContext): string[] {
  const h = ctx.history ?? [];
  if (h.length === 0) return [];
  const line = h.map((x) => x.status).join(" → ");
  return sameCodeEarlierPass(ctx)
    ? [`Earlier runs of the same code: ${line}. It has passed on this code before — it may be flaky rather than broken.`]
    : [`Earlier runs: ${line}.`];
}

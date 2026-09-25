/**
 * Every Proofwright tool answers the same way, so a tester always knows where
 * to look — and can pass the answer on to a developer as it is:
 *
 *   the result, in one line
 *   What I found — short; details only where something needs explaining
 *   What to do   — each step a person can act on
 *   Next         — the next step of the session, and what to say
 *   What I did   — one line at the end
 *
 * The text is for people; `data` carries the same result for machines (MCP
 * structured content), kept small — anything big lives in a file the answer
 * names.
 */
export interface Answer<T = unknown> {
  /** The one line a tester reads first. */
  headline: string;
  /** What the tool actually did — short, past tense, checkable. */
  did: string[];
  /** The result, in Markdown. */
  found: string;
  /** Decisions, answers or fixes only a person can give. Empty when there are none. */
  need: string[];
  /** The next step of the session, with what to say: "prove the tests — say …". */
  next?: string;
  data: T;
}

export function renderAnswer(a: Answer): string {
  const need = a.need.length === 0 ? ["Nothing to do."] : a.need.length === 1 ? [a.need[0]] : a.need.map((n, i) => `${i + 1}. ${n}`);
  return [
    `**${a.headline}**`,
    "",
    ...(a.found.trim() ? [a.found.trim(), ""] : []),
    "**What to do**",
    ...need,
    "",
    ...(a.next ? [`**Next:** ${a.next}`, ""] : []),
    `*What I did: ${a.did.join(" ")}*`,
    "",
  ].join("\n");
}

/** "1 file" / "3 files". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

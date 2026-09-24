/**
 * Every Proofwright tool answers the same way, so a tester always knows where
 * to look: a one-line headline, then
 *
 *   What I did · What I found · What I need from you
 *
 * The text is for the tester; `data` carries the same result for machines
 * (MCP structured content), so nothing the tester reads is lost to a client
 * that only reads JSON, and the other way round.
 */
export interface Answer<T = unknown> {
  /** The one line a tester reads first. */
  headline: string;
  /** What the tool actually did — short, past tense, checkable. */
  did: string[];
  /** The result, in Markdown. */
  found: string;
  /** Decisions or answers only the tester can give. Empty when there are none. */
  need: string[];
  /** A suggested next step when nothing is needed. */
  next?: string;
  data: T;
}

export function renderAnswer(a: Answer): string {
  const need =
    a.need.length > 0
      ? a.need.map((n, i) => `${i + 1}. ${n}`)
      : [`Nothing to decide.${a.next ? ` ${a.next}` : ""}`];
  return [
    `**${a.headline}**`,
    "",
    "### What I did",
    ...a.did.map((d) => `- ${d}`),
    "",
    "### What I found",
    a.found.trim(),
    "",
    "### What I need from you",
    ...need,
    "",
  ].join("\n");
}

/** "1 file" / "3 files". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

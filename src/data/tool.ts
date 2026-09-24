/**
 * The `test_data` tool: made-up values for a form's fields, each marked with
 * what the app should do with it, answered in the three-part format — and
 * saved to proofwright/data/<name>.json when the tester asks.
 */
import * as fs from "node:fs";
import { type Answer, count } from "../answer.js";
import { type Project, ProjectError } from "../project.js";
import { type DataSet, type Expect, type FieldSpec, generate, parseDay } from "./generate.js";

export interface TestDataInput {
  fields: FieldSpec[];
  seed?: number;
  /** YYYY-MM-DD; birth-date limits are worked out on this day. Defaults to today (UTC). */
  today?: string;
  /** Save as proofwright/data/<save>.json. */
  save?: string;
}

export interface TestDataResult extends DataSet {
  saved?: string;
}

const SAVE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EXPECT_WORD: Record<Expect, string> = { accept: "accept", refuse: "refuse", unknown: "ask you" };

export function testData(project: Project, input: TestDataInput, now = new Date()): Answer<TestDataResult> {
  const seed = input.seed ?? 1;
  if (!Number.isInteger(seed) || seed < 0) throw new ProjectError("seed must be a whole number of 0 or more.");
  let today = now;
  if (input.today !== undefined) {
    const day = parseDay(input.today);
    if (!day) throw new ProjectError("today must be a date written YYYY-MM-DD.");
    today = day;
  }
  if (input.save !== undefined && !SAVE_NAME.test(input.save)) {
    throw new ProjectError("save must be a short name of small letters, digits and dashes, like \"signup\".");
  }

  const set = generate(input.fields, { seed, today });
  const result: TestDataResult = { ...set };
  if (input.save) {
    const file = project.stateFile("data", `${input.save}.json`);
    fs.writeFileSync(file, `${JSON.stringify({ generatedBy: "proofwright test_data", ...set }, null, 2)}\n`);
    result.saved = project.relative(file);
  }

  const all = set.fields.flatMap((f) => f.cases);
  const tally = (e: Expect) => all.filter((c) => c.expect === e).length;
  const questions = [...new Set(set.fields.flatMap((f) => f.questions))];
  return {
    headline:
      `Test data for ${count(set.fields.length, "field")}: ${count(all.length, "value")} — ` +
      `${tally("accept")} to accept, ${tally("refuse")} to refuse` +
      (tally("unknown") > 0 ? `, ${tally("unknown")} for you to decide.` : "."),
    did: [
      `Made values for ${set.fields.map((f) => `**${f.field}**`).join(", ")} with seed ${seed}` +
        (set.fields.some((f) => f.kind === "birthDate") ? `, counting ages on ${set.today}` : "") +
        ". The same seed always gives the same values.",
      "Every value is made up: invented names, email addresses on reserved domains (example.com, example.org, .test), phone numbers from ranges reserved for fiction.",
      "Marked what the app should do with each value, from the rules you gave — nothing was sent to the app.",
      ...(result.saved ? [`Saved them to \`${result.saved}\`.`] : []),
    ],
    found: set.fields.map(renderField).join("\n\n"),
    need: questions,
    next: "Say which values to turn into tests" + (result.saved ? "." : ", or ask me to save them."),
    data: result,
  };
}

function renderField(f: DataSet["fields"][number]): string {
  const rows = f.cases.map(
    (c) => `| ${show(c.value)} | ${escape(c.probes)} | **${EXPECT_WORD[c.expect]}** — ${escape(c.because)} |`,
  );
  return [
    `**${f.field}** (${f.kind}) — rules: ${f.rules.length > 0 ? f.rules.join("; ") : "none given"}`,
    "",
    "| Value | What it checks | The app should |",
    "|---|---|---|",
    ...rows,
  ].join("\n");
}

/** A value as it would be typed, quoted so empty and space-only values are visible. */
function show(value: string): string {
  const chars = [...value];
  const shown = chars.length > 32 ? `${chars.slice(0, 24).join("")}…` : value;
  const quoted = JSON.stringify(shown).replace(/\|/g, "\\|").replace(/`/g, "'");
  return chars.length > 32 ? `\`${quoted}\` (${chars.length} characters)` : `\`${quoted}\``;
}

function escape(s: string): string {
  return s.replace(/\|/g, "\\|");
}

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DataError, type FieldSpec, generate, type DataSet } from "../src/data/generate.js";
import { testData } from "../src/data/tool.js";
import { Project, ProjectError } from "../src/project.js";

const TODAY = new Date("2026-09-24T12:00:00Z");

/** The sign-up form's rules, as demo/README.md states them. */
const SIGNUP: FieldSpec[] = [
  { name: "Full name", kind: "name", required: true, maxLength: 60 },
  { name: "Email", kind: "email", required: true },
  { name: "Password", kind: "password", required: true, minLength: 8, mustInclude: ["letter", "digit"] },
  { name: "Date of birth", kind: "birthDate", required: true, minAge: 18 },
];

const field = (set: DataSet, name: string) => set.fields.find((f) => f.field === name)!;
const expectOf = (set: DataSet, name: string, value: string) => {
  const c = field(set, name).cases.find((x) => x.value === value);
  assert.ok(c, `${name} has a case for ${JSON.stringify(value)}`);
  return c.expect;
};

test("test data: the same seed gives the same values; another seed, other values", () => {
  const a = generate(SIGNUP, { seed: 7, today: TODAY });
  const b = generate(SIGNUP, { seed: 7, today: TODAY });
  const c = generate(SIGNUP, { seed: 8, today: TODAY });
  assert.deepEqual(a, b);
  assert.notDeepEqual(
    field(a, "Password").cases.map((x) => x.value),
    field(c, "Password").cases.map((x) => x.value),
  );
});

test("test data: adding a field doesn't change the other fields' values", () => {
  const before = generate(SIGNUP.slice(0, 2), { seed: 3, today: TODAY });
  const after = generate(SIGNUP, { seed: 3, today: TODAY });
  assert.deepEqual(field(before, "Email"), field(after, "Email"));
});

test("test data: the shop's sign-up rules give the expectations its README promises", () => {
  const set = generate(SIGNUP, { seed: 1, today: TODAY });
  // Email: shaped like name@domain.tld.
  assert.equal(expectOf(set, "Email", "ada@example"), "refuse");
  assert.equal(expectOf(set, "Email", "a@b.test"), "accept");
  assert.equal(expectOf(set, "Email", "ada@example..com"), "refuse");
  assert.equal(expectOf(set, "Email", ""), "refuse");
  // Full name: up to 60 characters, in any script — counted in characters, not bytes.
  assert.equal(expectOf(set, "Full name", "王".repeat(60)), "accept");
  const over = field(set, "Full name").cases.find((c) => c.probes.startsWith("one character over"))!;
  assert.equal([...over.value].length, 61);
  assert.equal(over.expect, "refuse");
  assert.equal(expectOf(set, "Full name", "سارة أحمد"), "accept");
  // Date of birth: 18 or older, on 2026-09-24.
  assert.equal(expectOf(set, "Date of birth", "2008-09-24"), "accept");
  assert.equal(expectOf(set, "Date of birth", "2008-09-25"), "refuse");
  assert.equal(expectOf(set, "Date of birth", "2026-09-25"), "refuse");
  // Password: 8+ characters with a letter and a number.
  const pw = field(set, "Password").cases;
  for (const c of pw.filter((x) => x.group === "typical" || x.probes.startsWith("exactly the minimum"))) {
    assert.equal(c.expect, "accept", `${c.probes}: ${c.value}`);
    assert.match(c.value, /\p{L}/u);
    assert.match(c.value, /\d/);
  }
  const noNumber = pw.find((x) => x.probes === "no number")!;
  assert.doesNotMatch(noNumber.value, /\d/);
  assert.equal(noNumber.expect, "refuse");
  assert.equal(pw.find((x) => x.probes.startsWith("one character short"))!.value.length, 7);
});

test("test data: a quantity of 1–99 marks the limits and the tricky values", () => {
  const set = generate([{ name: "Quantity", kind: "number", required: true, integer: true, min: 1, max: 99 }], {
    seed: 1,
    today: TODAY,
  });
  for (const [value, expected] of [
    ["1", "accept"],
    ["99", "accept"],
    ["0", "refuse"],
    ["100", "refuse"],
    ["-1", "refuse"],
    ["1.5", "refuse"],
    ["abc", "refuse"],
    ["٣", "refuse"],
    ["1e2", "unknown"],
  ] as const) {
    assert.equal(expectOf(set, "Quantity", value), expected, value);
  }
  assert.ok(field(set, "Quantity").questions.some((q) => q.includes("1e2")));
});

test("test data: an address looks like one — not a sentence — with the unusual ones that break forms", () => {
  const [address] = generate([{ name: "Address", kind: "address", required: true }], { seed: 1, today: new Date("2026-09-25") }).fields;
  const typical = address.cases.filter((c) => c.group === "typical").map((c) => c.value);
  assert.ok(typical.every((v) => /^(Flat \d+, )?\d+ [A-Z][a-z]+ (Street|Avenue|Road|Lane)$/.test(v)), typical.join(" | "));
  const unusual = address.cases.filter((c) => c.group === "unusual").map((c) => c.probes);
  for (const probe of ["Arabic, written right to left", "ß, with the number after the street", "markup — must show as text, never as formatting"]) assert.ok(unusual.includes(probe), probe);
  assert.ok(address.cases.some((c) => c.value === "" && c.expect === "refuse"), "required: empty is refused");
});

test("test data: everything is made up — reserved email domains, fictional phone ranges", () => {
  const set = generate(
    [
      { name: "Email", kind: "email" },
      { name: "Phone", kind: "phone" },
    ],
    { seed: 99, today: TODAY },
  );
  // Every address that could be delivered at all must be on a reserved domain.
  for (const c of field(set, "Email").cases) {
    const domain = /@([^@\s]+)$/.exec(c.value.trim())?.[1];
    if (domain && /^[^.]+(\.[^.]+)+$/.test(domain)) {
      assert.match(domain.toLowerCase(), /(^|\.)(example\.(com|org|net)|test)$/, c.value);
    }
  }
  const typicalPhones = field(set, "Phone").cases.filter((c) => c.group === "typical").map((c) => c.value);
  assert.equal(typicalPhones.length, 2);
  assert.match(typicalPhones[0], /^\+44 7700 900\d{3}$/); // Ofcom's drama range
  assert.match(typicalPhones[1], /^\+1 202 555 01\d{2}$/); // 555-0100–0199, reserved for fiction
});

test("test data: when no rule decides, it asks instead of guessing", () => {
  const set = generate([{ name: "Nickname", kind: "name" }], { seed: 1, today: TODAY });
  const f = field(set, "Nickname");
  assert.equal(expectOf(set, "Nickname", ""), "unknown");
  assert.ok(f.questions.includes("Is **Nickname** required?"));
  assert.ok(f.questions.some((q) => q.startsWith("What are the rules for **Nickname**")));
  assert.equal(expectOf(set, "Nickname", "  Mara Lindqvist  "), "unknown");
});

test("test data: a pattern decides postal codes", () => {
  const set = generate([{ name: "Postcode", kind: "postalCode", required: true, pattern: "[0-9]{5}" }], {
    seed: 1,
    today: TODAY,
  });
  assert.equal(expectOf(set, "Postcode", "10115"), "accept");
  assert.equal(expectOf(set, "Postcode", "SW1A 1AA"), "refuse");
});

test("test data: 29 February — counted as a question, and handled on a leap-day today", () => {
  const leapToday = new Date("2028-02-29T09:00:00Z");
  const set = generate([{ name: "Born", kind: "birthDate", required: true, minAge: 18 }], { seed: 1, today: leapToday });
  // Turns 18 "today": 2010 has no 29 February, so the date is the 28th.
  assert.equal(expectOf(set, "Born", "2010-02-28"), "accept");
  assert.equal(expectOf(set, "Born", "2008-02-29"), "unknown");
  assert.ok(field(set, "Born").questions.some((q) => q.includes("29 February")));
});

test("test data: a bad field description is refused with a plain reason", () => {
  assert.throws(() => generate([], { seed: 1, today: TODAY }), DataError);
  assert.throws(
    () => generate([{ name: "X", kind: "colour" as never }], { seed: 1, today: TODAY }),
    /kind must be one of/,
  );
  assert.throws(
    () => generate([{ name: "X", kind: "text", minLength: 5, maxLength: 2 }], { seed: 1, today: TODAY }),
    /minLength is larger than maxLength/,
  );
  assert.throws(
    () => generate([{ name: "X", kind: "text", pattern: "([a-z" }], { seed: 1, today: TODAY }),
    /isn't a valid regular expression/,
  );
});

test("test data tool: saves to proofwright/data/<name>.json and says so", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-data-"));
  const answer = testData(new Project(dir), { fields: SIGNUP, seed: 5, today: "2026-09-24", save: "signup" });
  assert.equal(answer.data.saved, "proofwright/data/signup.json");
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "proofwright/data/signup.json"), "utf8"));
  assert.equal(saved.generatedBy, "proofwright test_data");
  assert.equal(saved.seed, 5);
  assert.equal(saved.today, "2026-09-24");
  assert.ok(answer.did.some((d) => d.includes("`proofwright/data/signup.json`")));
  assert.throws(() => testData(new Project(dir), { fields: SIGNUP, save: "../escape" }), ProjectError);
  assert.throws(() => testData(new Project(dir), { fields: SIGNUP, today: "24/09/2026" }), ProjectError);
});

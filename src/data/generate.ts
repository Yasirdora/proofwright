/**
 * Test data for a form's fields: typical values, the limits, invalid values,
 * and the unusual ones that often break apps (other scripts, right-to-left
 * text, emoji, markup, a character cut in half by a byte limit).
 *
 * Every value is made up. Names are invented; email addresses use reserved
 * domains (example.com, example.org, .test); phone numbers come from ranges
 * set aside for fiction. The same seed always gives the same values.
 *
 * Each value says whether the app should ACCEPT or REFUSE it — worked out
 * only from the rules the tester gave (plus a documented default for email,
 * phone and dates). When no rule decides, the value is marked UNKNOWN and the
 * tester is asked.
 */
import { Random } from "./random.js";

export const FIELD_KINDS = [
  "name",
  "email",
  "password",
  "text",
  "number",
  "date",
  "birthDate",
  "postalCode",
  "phone",
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export const CHARACTER_KINDS = ["letter", "digit", "upper", "lower", "symbol"] as const;
export type CharacterKind = (typeof CHARACTER_KINDS)[number];

export interface FieldSpec {
  /** The field's label, as the tester sees it. */
  name: string;
  kind: FieldKind;
  required?: boolean;
  /** In characters (not bytes). */
  minLength?: number;
  maxLength?: number;
  /** number: smallest/largest allowed. date: earliest/latest, YYYY-MM-DD. */
  min?: number | string;
  max?: number | string;
  /** number: whole numbers only. */
  integer?: boolean;
  /** A regular expression the whole value must match. */
  pattern?: string;
  /** password: kinds of character it must contain. */
  mustInclude?: CharacterKind[];
  /** birthDate: youngest and oldest allowed age, in whole years. */
  minAge?: number;
  maxAge?: number;
}

export type Expect = "accept" | "refuse" | "unknown";
export type Group = "typical" | "limit" | "invalid" | "unusual";

export interface DataCase {
  value: string;
  /** What the value checks, in plain words. */
  probes: string;
  group: Group;
  expect: Expect;
  /** Which rule decided — or what is still open. */
  because: string;
}

export interface FieldData {
  field: string;
  kind: FieldKind;
  /** The rules the expectations were worked out from. */
  rules: string[];
  cases: DataCase[];
  /** What the tester needs to answer before every expectation is known. */
  questions: string[];
}

export interface DataSet {
  seed: number;
  /** The date birth-date limits were worked out on (YYYY-MM-DD, UTC). */
  today: string;
  fields: FieldData[];
}

export class DataError extends Error {}

interface Draft {
  value: string;
  probes: string;
  group: Group;
  /** Set when the value raises a question no rule answers. */
  open?: { because: string; question: string };
}

const d = (value: string, probes: string, group: Group, open?: Draft["open"]): Draft => ({ value, probes, group, open });

export function generate(fields: FieldSpec[], opts: { seed: number; today: Date }): DataSet {
  if (fields.length === 0) throw new DataError("Name at least one field.");
  const today = utcDay(opts.today);
  const out: FieldData[] = [];
  fields.forEach((field, i) => {
    validateSpec(field);
    // Each field gets its own stream, so adding a field never changes the others' values.
    const rng = new Random(opts.seed * 1_000_003 + i * 7_919);
    const drafts = draftsFor(field, rng, today);
    const questions = new Set<string>();
    const cases: DataCase[] = [];
    const seen = new Set<string>();
    for (const draft of drafts) {
      if (seen.has(draft.value)) continue;
      seen.add(draft.value);
      const verdict = draft.open
        ? { expect: "unknown" as const, because: draft.open.because }
        : judge(field, draft.value, today);
      if (draft.open) questions.add(draft.open.question);
      if (verdict.expect === "unknown" && verdict.question) questions.add(verdict.question);
      cases.push({ value: draft.value, probes: draft.probes, group: draft.group, expect: verdict.expect, because: verdict.because });
    }
    const rules = describeRules(field);
    if (rules.length === 0) {
      questions.add(
        `What are the rules for **${field.name}** (length, allowed characters)? Without them I've marked every non-empty value as accepted.`,
      );
    }
    out.push({ field: field.name, kind: field.kind, rules, cases, questions: [...questions] });
  });
  return { seed: opts.seed, today: iso(today), fields: out };
}

// ---------------------------------------------------------------- the values

const NAMES = [
  "Mara Lindqvist",
  "Tomás Ferreira",
  "Aiko Tanaka",
  "Noah Okafor",
  "Leila Haddad",
  "Jonas Weber",
  "Priya Raman",
  "Sofia Rossi",
];

function draftsFor(f: FieldSpec, rng: Random, today: Date): Draft[] {
  switch (f.kind) {
    case "name":
      return [
        d(rng.pick(NAMES), "a typical name", "typical"),
        ...lengthLimits(f, "Mara Lindqvist"),
        d("", "left empty", "invalid"),
        d("   ", "only spaces", "invalid"),
        d("Zoë Ångström", "accents and a ring above", "unusual"),
        d("王小明", "Chinese characters", "unusual"),
        d("سارة أحمد", "Arabic, written right to left", "unusual"),
        d("דנה כהן", "Hebrew, written right to left", "unusual"),
        d("Siobhán O'Connell", "an apostrophe", "unusual"),
        d("Anne-Marie Dubois", "a hyphen", "unusual"),
        d("Zoë Lind", "an accent typed as a separate mark (decomposed Unicode)", "unusual"),
        d("Ana 🌸 Lima", "an emoji", "unusual"),
        d("A", "a single letter", "unusual"),
        d("<b>Mara</b>", "markup — must show as text, never as formatting", "unusual"),
        d("<script>alert(1)</script>", "a script tag — must show as text, never run", "unusual"),
        d("  Mara Lindqvist  ", "spaces before and after", "unusual", trimQuestion(f)),
      ];
    case "email":
      return [
        d(`tester.${rng.int(100, 999)}@example.com`, "a typical address", "typical"),
        d("first.last+news@example.org", "plus addressing (+news)", "typical"),
        d("a@b.test", "a very short address", "limit"),
        ...emailLengthLimits(f),
        d("ada@example", "no domain ending (.com, .org …)", "invalid"),
        d("plainaddress", "no @", "invalid"),
        d("@example.com", "nothing before the @", "invalid"),
        d("ada@", "nothing after the @", "invalid"),
        d("ada lovelace@example.com", "a space inside", "invalid"),
        d("ada@@example.com", "two @ signs", "invalid"),
        d("ada@example..com", "two dots in a row", "invalid"),
        d("", "left empty", "invalid"),
        d("TESTER.CAPS@EXAMPLE.COM", "capital letters — should reach the same account as lower case", "unusual"),
        d("zoë@example.com", "a non-English letter before the @", "unusual", {
          because: "international addresses are allowed by some apps and refused by others",
          question: `Should **${f.name}** accept addresses with non-English letters (like zoë@example.com)?`,
        }),
        d("  tester@example.com  ", "spaces before and after", "unusual", trimQuestion(f)),
      ];
    case "password": {
      const must = f.mustInclude ?? [];
      const typicalLength = clamp(Math.max(f.minLength ?? 0, 12), f.minLength, f.maxLength);
      const drafts = [d(password(rng, typicalLength, must), "a typical password", "typical")];
      if (f.minLength !== undefined) {
        drafts.push(d(password(rng, f.minLength, must), `exactly the minimum length (${f.minLength})`, "limit"));
        if (f.minLength > 1) {
          drafts.push(d(password(rng, f.minLength - 1, must), `one character short (${f.minLength - 1})`, "limit"));
        }
      }
      if (f.maxLength !== undefined) {
        drafts.push(d(password(rng, f.maxLength, must), `exactly the maximum length (${f.maxLength})`, "limit"));
        drafts.push(d(password(rng, f.maxLength + 1, must), `one character over (${f.maxLength + 1})`, "limit"));
      }
      for (const missing of must) {
        drafts.push(
          d(password(rng, typicalLength, must.filter((m) => m !== missing), missing), `no ${CHAR_WORD[missing]}`, "invalid"),
        );
      }
      drafts.push(
        d("", "left empty", "invalid"),
        d(padTo("pässwörd12", typicalLength), "letters outside English", "unusual"),
        d(padTo("pass word 12", typicalLength), "a space inside", "unusual"),
      );
      if (f.maxLength === undefined) {
        drafts.push(d(password(rng, 200, must), "200 characters — nothing should cut it short", "unusual"));
      }
      return drafts;
    }
    case "text":
      return [
        d("Please leave the parcel with the neighbour at number 12.", "a typical sentence", "typical"),
        ...lengthLimits(f, "Leave it at the door"),
        d("", "left empty", "invalid"),
        d("   ", "only spaces", "invalid"),
        d("Line one\nLine two", "a line break", "unusual"),
        d("Café ☕ — naïve résumé", "accents and an emoji", "unusual"),
        d("مرحبا بالعالم", "Arabic, written right to left", "unusual"),
        d('She said "hi" & left <quietly>', "quotes, & and angle brackets — must show exactly as typed", "unusual"),
        d("<script>alert(1)</script>", "a script tag — must show as text, never run", "unusual"),
        ...(f.maxLength === undefined
          ? [d("Lorem ipsum dolor sit amet. ".repeat(40).trim(), "about 1,100 characters — nothing should cut or break it", "unusual")]
          : []),
      ];
    case "number":
      return numberDrafts(f, rng);
    case "date":
      return dateDrafts(f, rng, today);
    case "birthDate":
      return birthDateDrafts(f, rng, today);
    case "postalCode":
      return [
        d("D02 X285", "an Irish Eircode", "typical"),
        d("SW1A 1AA", "a UK postcode", "typical"),
        d("10115", "a German postcode", "typical"),
        d("75008", "a French postcode", "typical"),
        d("1012 AB", "a Dutch postcode", "typical"),
        d("K1A 0B1", "a Canadian postal code", "typical"),
        d("10001-1234", "a US ZIP+4", "typical"),
        d("100-0001", "a Japanese postal code", "typical"),
        d("", "left empty", "invalid"),
        d("!", "a symbol only", "invalid"),
        d("123456789012", "twelve digits", "invalid"),
        d("sw1a 1aa", "lower case", "unusual"),
        d(" D02 X285 ", "spaces before and after", "unusual", trimQuestion(f)),
      ];
    case "phone":
      return [
        d(`+44 7700 900${rng.int(100, 999)}`, "a UK mobile (fictional range)", "typical"),
        d(`+1 202 555 01${rng.int(10, 99)}`, "a US number (fictional 555-01xx)", "typical"),
        d("07700 900123", "national format, no country code", "unusual"),
        d("(202) 555-0147", "brackets and a dash", "unusual"),
        d("+44 (0) 7700 900123", "the (0) some people add", "unusual"),
        d("", "left empty", "invalid"),
        d("abc", "letters", "invalid"),
        d("12", "two digits", "invalid"),
        d("+", "just a plus sign", "invalid"),
        d("1".repeat(25), "25 digits", "invalid"),
      ];
  }
}

function trimQuestion(f: FieldSpec): Draft["open"] {
  return {
    because: "it depends on whether the app trims spaces",
    question: `Should **${f.name}** ignore spaces typed before and after the value?`,
  };
}

/** Values at the length limits, in plain letters — and in 3-byte characters, which catch byte-counting bugs. */
function lengthLimits(f: FieldSpec, sample: string): Draft[] {
  const out: Draft[] = [];
  if (f.minLength !== undefined && f.minLength > 0) {
    out.push(d(padTo(sample, f.minLength), `exactly the minimum length (${f.minLength})`, "limit"));
    if (f.minLength > 1) out.push(d(padTo(sample, f.minLength - 1), `one character short (${f.minLength - 1})`, "limit"));
  }
  if (f.maxLength !== undefined) {
    out.push(d(padTo(sample, f.maxLength), `exactly the maximum length (${f.maxLength})`, "limit"));
    out.push(d(padTo(sample, f.maxLength + 1), `one character over (${f.maxLength + 1})`, "limit"));
    out.push(
      d(
        "王".repeat(f.maxLength),
        `the maximum length in Chinese characters (${f.maxLength} characters, ${f.maxLength * 3} bytes) — catches limits counted in bytes`,
        "limit",
      ),
    );
  }
  return out;
}

function emailLengthLimits(f: FieldSpec): Draft[] {
  if (f.maxLength === undefined) return [];
  const domain = "@example.com";
  const local = (n: number) => "a".repeat(Math.max(1, n - domain.length));
  return [
    d(`${local(f.maxLength)}${domain}`, `exactly the maximum length (${f.maxLength})`, "limit"),
    d(`${local(f.maxLength + 1)}${domain}`, `one character over (${f.maxLength + 1})`, "limit"),
  ];
}

function numberDrafts(f: FieldSpec, rng: Random): Draft[] {
  const min = typeof f.min === "number" ? f.min : undefined;
  const max = typeof f.max === "number" ? f.max : undefined;
  const step = f.integer ? 1 : 0.01;
  const lo = min ?? 1;
  const hi = max ?? Math.max(lo + 10, 10);
  const typical = f.integer ? rng.int(Math.ceil(lo), Math.floor(hi)) : Math.round((lo + rng.next() * (hi - lo)) * 100) / 100;
  const num = (n: number) => String(Number(n.toFixed(2)));
  const out = [d(num(typical), "a typical value", "typical")];
  if (min !== undefined) {
    out.push(d(num(min), `exactly the minimum (${num(min)})`, "limit"), d(num(min - step), `just below the minimum`, "limit"));
  }
  if (max !== undefined) {
    out.push(d(num(max), `exactly the maximum (${num(max)})`, "limit"), d(num(max + step), `just above the maximum`, "limit"));
  }
  out.push(
    d("0", "zero", "limit"),
    d("-1", "a negative number", "limit"),
    d("1.5", "a fraction", f.integer ? "invalid" : "typical"),
    d("", "left empty", "invalid"),
    d("abc", "letters", "invalid"),
    d("٣", "the digit 3 written in Arabic-Indic script", "unusual"),
    d("99999999999999999999", "a very large number — nothing should overflow", "unusual"),
    d("1e2", "scientific notation", "unusual", {
      because: "some apps read 1e2 as 100",
      question: `Should **${f.name}** accept numbers written like 1e2?`,
    }),
    d(" 5 ", "spaces around the number", "unusual", trimQuestion(f)),
  );
  return out;
}

function dateDrafts(f: FieldSpec, rng: Random, today: Date): Draft[] {
  const min = typeof f.min === "string" ? parseDay(f.min) : null;
  const max = typeof f.max === "string" ? parseDay(f.max) : null;
  const lo = min ?? addDays(today, -365);
  const hi = max ?? addDays(today, 365);
  const span = Math.max(0, Math.round((hi.getTime() - lo.getTime()) / DAY));
  const out = [d(iso(addDays(lo, rng.int(0, span))), "a typical date", "typical")];
  if (min) out.push(d(iso(min), "exactly the earliest allowed date", "limit"), d(iso(addDays(min, -1)), "the day before", "limit"));
  if (max) out.push(d(iso(max), "exactly the latest allowed date", "limit"), d(iso(addDays(max, 1)), "the day after", "limit"));
  out.push(
    d("2024-02-29", "a leap day", "unusual"),
    d("2023-02-29", "29 February in a year without one", "invalid"),
    d("2024-13-01", "month 13", "invalid"),
    d("31/12/1990", "day/month/year instead of YYYY-MM-DD", "invalid"),
    d("", "left empty", "invalid"),
  );
  return out;
}

function birthDateDrafts(f: FieldSpec, rng: Random, today: Date): Draft[] {
  const out = [d(iso(yearsBefore(today, rng.int(25, 45))), "a typical adult", "typical")];
  if (f.minAge !== undefined) {
    out.push(
      d(iso(yearsBefore(today, f.minAge)), `turns ${f.minAge} today`, "limit"),
      d(iso(addDays(yearsBefore(today, f.minAge), 1)), `turns ${f.minAge} tomorrow`, "limit"),
    );
  }
  if (f.maxAge !== undefined) {
    const oldest = addDays(yearsBefore(today, f.maxAge + 1), 1);
    out.push(
      d(iso(oldest), `${f.maxAge}, turning ${f.maxAge + 1} tomorrow`, "limit"),
      d(iso(yearsBefore(today, f.maxAge + 1)), `turns ${f.maxAge + 1} today`, "limit"),
    );
  }
  out.push(
    d(iso(addDays(today, 1)), "tomorrow — a birth date in the future", "invalid"),
    d(iso(today), "born today", "limit"),
    d("2023-02-29", "29 February in a year without one", "invalid"),
    d("", "left empty", "invalid"),
    d("2008-02-29", "born on 29 February", "unusual", {
      because: "whether a 29 February birthday counts on 28 February or 1 March in other years",
      question: `For **${f.name}**: in a year without 29 February, does someone born on 29 February have their birthday on 28 February or 1 March?`,
    }),
  );
  return out;
}

// ---------------------------------------------------------------- judging

const DEFAULT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/u;
const DEFAULT_PHONE_CHARS = /^\+?[0-9 ()-]+$/;

function judge(
  f: FieldSpec,
  value: string,
  today: Date,
): { expect: Expect; because: string; question?: string } {
  const accept = (because: string) => ({ expect: "accept" as const, because });
  const refuse = (because: string) => ({ expect: "refuse" as const, because });

  if (value.trim() === "") {
    if (f.required === true) return refuse("the field is required");
    if (f.required === false) return accept("the field is optional");
    return {
      expect: "unknown",
      because: "you haven't said whether the field is required",
      question: `Is **${f.name}** required?`,
    };
  }

  const length = [...value].length;
  if (f.minLength !== undefined && length < f.minLength) return refuse(`${length} characters; the minimum is ${f.minLength}`);
  if (f.maxLength !== undefined && length > f.maxLength) return refuse(`${length} characters; the maximum is ${f.maxLength}`);
  if (f.pattern !== undefined && !new RegExp(`^(?:${f.pattern})$`, "u").test(value)) {
    return refuse("it doesn't match the pattern you gave");
  }

  switch (f.kind) {
    case "email":
      if (value.includes("..") || !DEFAULT_EMAIL.test(value)) return refuse("it isn't shaped like name@domain.tld");
      break;
    case "password":
      for (const kind of f.mustInclude ?? []) {
        if (!CHAR_TEST[kind].test(value)) return refuse(`it has no ${CHAR_WORD[kind]}`);
      }
      break;
    case "number": {
      if (!/^-?\d+(\.\d+)?$/.test(value)) return refuse("it isn't a number written with the digits 0–9");
      const n = Number(value);
      if (f.integer && !Number.isInteger(n)) return refuse("it isn't a whole number");
      if (typeof f.min === "number" && n < f.min) return refuse(`it's below the minimum (${f.min})`);
      if (typeof f.max === "number" && n > f.max) return refuse(`it's above the maximum (${f.max})`);
      break;
    }
    case "date": {
      const day = parseDay(value);
      if (!day) return refuse("it isn't a real date written YYYY-MM-DD");
      if (typeof f.min === "string" && day < (parseDay(f.min) as Date)) return refuse(`it's before ${f.min}`);
      if (typeof f.max === "string" && day > (parseDay(f.max) as Date)) return refuse(`it's after ${f.max}`);
      break;
    }
    case "birthDate": {
      const day = parseDay(value);
      if (!day) return refuse("it isn't a real date written YYYY-MM-DD");
      if (day > today) return refuse("it's in the future");
      const age = ageOn(day, today);
      if (f.minAge !== undefined && age < f.minAge) return refuse(`${age} years old; the youngest allowed is ${f.minAge}`);
      if (f.maxAge !== undefined && age > f.maxAge) return refuse(`${age} years old; the oldest allowed is ${f.maxAge}`);
      break;
    }
    case "phone": {
      const digits = (value.match(/\d/g) ?? []).length;
      if (!DEFAULT_PHONE_CHARS.test(value) || digits < 6 || digits > 15) {
        return refuse("it isn't 6–15 digits (with spaces, +, brackets or dashes)");
      }
      break;
    }
    default:
      break;
  }
  return accept(describeRules(f).length > 0 ? "it meets every rule" : "no rule refuses it");
}

function describeRules(f: FieldSpec): string[] {
  const r: string[] = [];
  if (f.required === true) r.push("required");
  if (f.required === false) r.push("optional");
  if (f.minLength !== undefined) r.push(`at least ${f.minLength} characters`);
  if (f.maxLength !== undefined) r.push(`at most ${f.maxLength} characters`);
  if (f.pattern !== undefined) r.push(`matches \`${f.pattern}\``);
  if (f.kind === "email") r.push("shaped like name@domain.tld (the usual rule — tell me if yours differs)");
  if (f.kind === "password" && f.mustInclude?.length) r.push(`contains ${f.mustInclude.map((k) => `a ${CHAR_WORD[k]}`).join(", ")}`);
  if (f.kind === "number") r.push(f.integer ? "a whole number" : "a number");
  if (f.kind === "number" && typeof f.min === "number") r.push(`at least ${f.min}`);
  if (f.kind === "number" && typeof f.max === "number") r.push(`at most ${f.max}`);
  if (f.kind === "date" || f.kind === "birthDate") r.push("a real date, YYYY-MM-DD");
  if (f.kind === "date" && typeof f.min === "string") r.push(`on or after ${f.min}`);
  if (f.kind === "date" && typeof f.max === "string") r.push(`on or before ${f.max}`);
  if (f.kind === "birthDate" && f.minAge !== undefined) r.push(`at least ${f.minAge} years old`);
  if (f.kind === "birthDate" && f.maxAge !== undefined) r.push(`at most ${f.maxAge} years old`);
  if (f.kind === "phone") r.push("6–15 digits; spaces, +, brackets and dashes allowed (the usual rule — tell me if yours differs)");
  return r;
}

function validateSpec(f: FieldSpec): void {
  if (!f.name?.trim()) throw new DataError("Every field needs a name.");
  if (!FIELD_KINDS.includes(f.kind)) {
    throw new DataError(`"${f.name}": kind must be one of ${FIELD_KINDS.join(", ")}.`);
  }
  for (const k of ["minLength", "maxLength", "minAge", "maxAge"] as const) {
    const v = f[k];
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new DataError(`"${f.name}": ${k} must be a whole number of 0 or more.`);
  }
  if (f.minLength !== undefined && f.maxLength !== undefined && f.minLength > f.maxLength) {
    throw new DataError(`"${f.name}": minLength is larger than maxLength.`);
  }
  if (f.pattern !== undefined) {
    try {
      new RegExp(f.pattern, "u");
    } catch (err) {
      throw new DataError(`"${f.name}": the pattern isn't a valid regular expression (${(err as Error).message}).`);
    }
  }
  if (f.kind === "date") {
    for (const k of ["min", "max"] as const) {
      const v = f[k];
      if (v !== undefined && (typeof v !== "string" || !parseDay(v))) throw new DataError(`"${f.name}": ${k} must be a date written YYYY-MM-DD.`);
    }
  }
  if (f.kind === "number") {
    for (const k of ["min", "max"] as const) {
      const v = f[k];
      if (v !== undefined && typeof v !== "number") throw new DataError(`"${f.name}": ${k} must be a number.`);
    }
  }
  for (const k of f.mustInclude ?? []) {
    if (!CHARACTER_KINDS.includes(k)) throw new DataError(`"${f.name}": mustInclude can list ${CHARACTER_KINDS.join(", ")}.`);
  }
}

// ---------------------------------------------------------------- passwords

const CHAR_WORD: Record<CharacterKind, string> = {
  letter: "letter",
  digit: "number",
  upper: "capital letter",
  lower: "small letter",
  symbol: "symbol",
};
const CHAR_TEST: Record<CharacterKind, RegExp> = {
  letter: /\p{L}/u,
  digit: /\d/,
  upper: /\p{Lu}/u,
  lower: /\p{Ll}/u,
  symbol: /[^\p{L}\d\s]/u,
};
const POOL: Record<CharacterKind, string> = {
  letter: "abcdefghijkmnpqrstuvwxyz",
  digit: "23456789",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  lower: "abcdefghijkmnpqrstuvwxyz",
  symbol: "!#%&*+-=?@^_",
};

/**
 * A made-up password of `length` characters containing each kind in `must`,
 * and — when `without` is set — none of that kind (so it breaks exactly one rule).
 */
function password(rng: Random, length: number, must: CharacterKind[], without?: CharacterKind): string {
  const banned = without ? CHAR_TEST[without] : null;
  const allowed = (s: string) => [...s].filter((c) => !banned || !banned.test(c)).join("");
  const fill = allowed(without === "digit" ? POOL.letter + POOL.upper : POOL.lower + POOL.digit) || POOL.symbol;
  const chars: string[] = must.map((k) => rng.pick([...allowed(POOL[k])]));
  while (chars.length < length) chars.push(rng.pick([...fill]));
  // Shuffle, so the required characters aren't always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.slice(0, length).join("");
}

// ---------------------------------------------------------------- small helpers

function padTo(sample: string, length: number): string {
  if (length <= 0) return "";
  const base = [...sample];
  const out: string[] = [];
  while (out.length < length) out.push(...(out.length === 0 ? base : ["x"]));
  return out.slice(0, length).join("");
}

function clamp(n: number, min?: number, max?: number): number {
  return Math.min(Math.max(n, min ?? n), max ?? n);
}

const DAY = 86_400_000;

function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY);
}

/** The same calendar day `years` years earlier (29 Feb → 28 Feb in a common year). */
function yearsBefore(date: Date, years: number): Date {
  const y = date.getUTCFullYear() - years;
  const m = date.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(date.getUTCDate(), lastDay)));
}

/** A real calendar day written YYYY-MM-DD, or null. */
export function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, day));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === day ? date : null;
}

function ageOn(born: Date, today: Date): number {
  let age = today.getUTCFullYear() - born.getUTCFullYear();
  const before =
    today.getUTCMonth() < born.getUTCMonth() ||
    (today.getUTCMonth() === born.getUTCMonth() && today.getUTCDate() < born.getUTCDate());
  if (before) age -= 1;
  return age;
}

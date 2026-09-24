/**
 * The review rules that already exist in eslint-plugin-playwright are checked
 * by it — Proofwright doesn't rebuild them. This module runs the plugin's
 * rules on one file with ESLint's Linter and maps each message onto a
 * Proofwright rule, keeping the plugin's rule name as the source.
 *
 * Only this configuration is used: the tester's own ESLint setup is never read
 * or changed, so the review is the same in every project.
 */
import { Linter } from "eslint";
import playwright from "eslint-plugin-playwright";
import * as tsParser from "@typescript-eslint/parser";
import type { RuleId } from "./rules.js";

/** Plugin rule → the Proofwright rule it checks. */
export const PLUGIN_RULES: Record<string, RuleId> = {
  "no-wait-for-timeout": "fixed-wait",
  "expect-expect": "no-assertion",
  "missing-playwright-await": "unawaited-expect",
  "no-force-option": "forced-action",
  "no-focused-test": "focused-test",
  "no-skipped-test": "skipped-test",
  "no-raw-locators": "fragile-selector",
  "no-nth-methods": "fragile-selector",
};

export interface PluginFinding {
  rule: RuleId;
  line: number;
  /** "eslint-plugin-playwright/no-wait-for-timeout". */
  source: string;
  message: string;
}

export interface PluginResult {
  findings: PluginFinding[];
  /** Set when the file couldn't be parsed. */
  error?: string;
}

const linter = new Linter({ configType: "flat" });

/**
 * Lint one file's text. `assertingHelpers` are functions that assert on the
 * test's behalf, so a test that calls one isn't "a test with no assertion".
 */
export function lintWithPlugin(filename: string, text: string, assertingHelpers: string[]): PluginResult {
  const rules: Linter.RulesRecord = {};
  for (const name of Object.keys(PLUGIN_RULES)) rules[`playwright/${name}`] = "error";
  rules["playwright/expect-expect"] = ["error", { assertFunctionNames: assertingHelpers }];
  rules["playwright/no-skipped-test"] = ["error", { allowConditional: true }];

  const config: Linter.Config[] = [
    {
      files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
      languageOptions: {
        parser: tsParser,
        ecmaVersion: "latest",
        sourceType: "module",
        parserOptions: { ecmaFeatures: { jsx: /\.[jt]sx$/.test(filename) } },
      },
      plugins: { playwright },
      rules,
    },
  ];

  const messages = linter.verify(text, config, { filename });
  const fatal = messages.find((m) => m.fatal);
  if (fatal) return { findings: [], error: `line ${fatal.line}: ${fatal.message}` };
  const findings: PluginFinding[] = [];
  for (const m of messages) {
    const name = m.ruleId?.replace(/^playwright\//, "");
    const rule = name ? PLUGIN_RULES[name] : undefined;
    if (!rule || !name) continue;
    findings.push({ rule, line: m.line, source: `eslint-plugin-playwright/${name}`, message: m.message });
  }
  return { findings };
}

# Decisions

Choices made while building v0.1 that the spec leaves open. Newest last. A
decision that changes what the spec promises goes to the owner first.

## 2026-09-24 · TypeScript 5.9, not 7

TypeScript 7 (the native rewrite) is current on npm, but its compiler API is not
the classic JavaScript API the `review` rules (M1) are built on. 5.9.3 is stable
and has it. Revisit when 7's API settles.

## 2026-09-24 · The demo shop is plain JavaScript, type-checked

Proofwright Shop is modern JavaScript (ES modules) with no build step and no
framework, so it runs with one command — as the spec asks. It is still
type-checked: `// @ts-check` in every file and `tsc --checkJs` in `npm run check`.
The MCP server itself (M1 on) is TypeScript.

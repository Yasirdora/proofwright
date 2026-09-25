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

## 2026-09-24 · Playwright 1.61.1, pinned

1.63 is current, but it needs a Chromium build (1243) this machine doesn't have —
a ~150 MB download. 1.61.1 uses the Chromium already installed (1228), which
another project here uses too. Upgrading is one version bump plus
`npx playwright install chromium`, whenever the owner wants it.

## 2026-09-24 · The shop runs on port 4610, and tests never reuse a server

Vite dev servers take ports from 5173 upward; while building M0, eDraft's dev
server was on 5199 and an early check hit it instead of the shop. 4610 is outside
those ranges, and `reuseExistingServer: false` makes a busy port fail loudly
instead of testing the wrong app.

## 2026-09-24 · The answer key is executable, and off limits to Proofwright

Each planted bug has a test that asserts the shop's promise and is marked
`test.fail()`: it passes while the bug is there and turns red if the bug
disappears, so the key can't drift from the app. Its failure messages show
the bug directly (−€2.40 for −€1.20, a 201 where a 400 is required). The
answer key and the colleague's review key live in `demo/answer-key/`, which
Proofwright must never read while it explores, plans, writes or reviews;
M1's tools enforce that with an ignore list.

## 2026-09-24 · Build on Playwright's agents; don't rebuild them

Checked while building M1a, at the owner's prompt ("we do not want to build
something they already build"). Playwright 1.61 ships three agents —
planner, generator, healer (`npx playwright init-agents`) — over its own test
MCP server (`planner_save_plan`, `generator_write_test`, `test_run`,
`test_debug`, `browser_snapshot` …). The spec's `explore`, `plan`,
`write_tests` and `run` would duplicate them. The healer is the opposite of
Proofwright: its instructions say to fix "assertions and expected values", not
to ask the user, and to "do the most reasonable thing possible to pass the
test". The owner agreed to re-scope Proofwright as the trust layer on top of
those agents; the spec (docs/SPEC.md §1–3, §5, §6, §8–10) was re-scoped
accordingly on the owner's yes to the diff.

## 2026-09-24 · `review` reuses eslint-plugin-playwright for the rules it has

Seven of the thirteen review rules exist in eslint-plugin-playwright 2.12
(`no-wait-for-timeout`, `expect-expect`, `missing-playwright-await`,
`no-force-option`, `no-focused-test`, `no-skipped-test`, `no-raw-locators`,
`no-nth-methods`), so it checks them. Proofwright keeps only what it lacks:
tests that hand data to each other, serial mode, shared accounts, passwords
and real personal data in tests, retries — plus two gaps in the plugin: the
selector-string page API (`page.fill("input[name=…]")`) and `.fixme`.

- It runs through ESLint's `Linter` with an explicit configuration, so the
  tester's own ESLint setup is never read or changed and every project is
  reviewed the same way.
- The plugin's stricter meaning is adopted: any `.skip` left in is a finding,
  as is every raw CSS locator and `.first()`/`.nth()`. The review key
  (demo/answer-key/REVIEW.md) gained the colleague's lines 31 and 59.
- A skipped, empty test isn't also reported as "no assertion": the skip is the
  finding.
- Every finding names who found it — the plugin's rule, or Proofwright.

## 2026-09-24 · The MCP server uses the SDK's low-level `Server`

Tools are declared with hand-written JSON Schemas and inputs are checked by
hand, so no schema library appears in Proofwright's own code. Answers go out
as text (the three parts) plus the same result as structured content.

## 2026-09-24 · Runtime dependencies, and Node 20.19

`typescript` moved to the runtime dependencies (`review` parses test files with
it), next to `@modelcontextprotocol/sdk`, `eslint`, `eslint-plugin-playwright`
and `@typescript-eslint/parser`, all pinned. ESLint 10 needs Node 20.19 or
newer, so `engines` says so. `npm audit` found nothing. The one install script
in the tree, `fsevents` (Playwright's optional macOS file-watcher, used only by
its watch/UI modes), stays unapproved: nothing here needs it.

## 2026-09-24 · `test_data` marks only what the rules decide

An expectation (accept/refuse) comes only from the rules the tester gives, plus
three documented defaults — email shaped like name@domain.tld, phone numbers of
6–15 digits, dates written YYYY-MM-DD — each named in the answer. When no rule
decides (is the field required? should spaces be trimmed? does 1e2 count?), the
value is marked for the tester and the question is asked. Every value is made
up: invented names, reserved email domains (example.com, example.org, .test),
phone numbers from ranges set aside for fiction (Ofcom's 07700 900xxx, the
US 555-01xx). The seed defaults to 1; each field draws from its own stream, so
adding a field never changes the others.

## 2026-09-24 · A fixed password in a test is always a finding

The rule is strict — any literal typed into a password field — rather than
guessing whether a sign-up form makes it harmless. The shop's own tests typed
fixed passwords into three sign-up tests, against their helper's promise that
passwords are "never written into a test"; they now generate one per run
(`newPassword()`), and the rule stays strict.

## 2026-09-24 · `review` reads only Playwright test files

A `*.test.ts` file isn't necessarily a Playwright test: projects keep Jest,
Vitest and node:test suites next to their Playwright specs. Reviewing this
repository whole flagged Proofwright's own node:test unit tests 34 times. A file
now counts only if it really imports `@playwright/test` (or `playwright/test`),
itself or through a local module such as a fixtures file — read with the
TypeScript compiler's import scanner, so text inside strings never counts. The
rest are left out, and named in the answer.

## 2026-09-24 · M1b: `approve_plan` works on Playwright's own plan format

The plan Playwright's planner saves (`specs/*.md`) is the source; Proofwright's
test cases (`proofwright/cases/<name>.md`, Action · Data · Expected result)
are generated from it, never edited by hand — change the plan, run
`approve_plan` again. Case numbers are stable across re-plans. An approval is
tied to a fingerprint of its case: if the plan changes the case, the approval
lapses. Approved cases are written back in Playwright's own plan format
(`specs/<name>.approved.md`), each title starting with its case number, so
Playwright's generator reads it like any plan and every test traces to its case.
A contract test runs Playwright's real `planner_save_plan` and requires the
reader to read it exactly and the writer to write it byte for byte — a
Playwright release that changes the format fails that test.

A case with no expected result anywhere can't be approved (it could never
fail). Unclear steps — a value typed but not named, "works as expected" —
are questions; approving accepts them as they are.

## 2026-09-24 · The approval comes from the tester

When the app can show a form (MCP elicitation — Claude Code in the terminal,
from 2.1.76; not yet the desktop app, anthropics/claude-code#41110),
Proofwright asks the tester directly and the AI's words are ignored. Otherwise
it needs the tester's own words, passed verbatim, and records that they were
relayed by the AI client. That second path is only as honest as the client.

## 2026-09-24 · `/proofwright`, and where the agents start

The prompt names each step, who does it, and where the tester decides. The
project's `proofwright/config.json` can name the Playwright project, seed test
and tests folder for the agents: measured, Playwright's planner uses the first
project in the config by default and fails with "seed test not found" when the
seed lives elsewhere. The demo names project `generated`.

## 2026-09-24 · `proofwright init` protects the project's MCP servers

Measured: `npx playwright init-agents` replaces `.mcp.json`, dropping every
other MCP server in it. `init` reads the file first and puts those servers
back, and says which. It shows its changes and makes them only with `--yes`.
Playwright also installs its healer agent; `init` says Proofwright never uses
it, and leaves the choice to delete it to the tester.

## 2026-09-24 · The demo carries Playwright's planner and generator — not the healer

`.claude/agents/` holds the two agent files Playwright's `init-agents` wrote
(1.61.1); the healer's is left out on purpose. `.mcp.json` registers Playwright's
test server and Proofwright (`node dist/src/cli.js mcp`, relative to the repo).
Generated tests go to `demo/generated/`, a Playwright project of its own that
`npm test` leaves out — they meet the planted bugs. Its seed test checks the
products page, so review stays clean.

## 2026-09-24 · M2: `report` runs Playwright's runner; it doesn't rebuild it

A run is `npx playwright test` with the project's own config; Proofwright adds
only the JSON reporter (to `PLAYWRIGHT_JSON_OUTPUT_FILE`) and
`--trace=retain-on-failure`. Or it reads a JSON report the tester already has,
from CI. Playwright's `test_run` MCP tool answers in text for an agent to read;
there is nothing in it to keep and compare, which is why `report` asks the
runner for its JSON report instead.

Each run is kept in `proofwright/runs/<id>/` with every failure's evidence
copied beside it — the screenshot, `error-context.md` (Playwright's error
details and the page's accessibility snapshot at the failure) and the trace
(up to 20 MB) — because Playwright clears `test-results/` on its next run.
`proofwright/runs/` stays out of git; the reports (`proofwright/reports/`) are
meant to be kept. `proofwright init` now adds the `.gitignore` entry too.

## 2026-09-24 · How `explain` decides, and how sure it says it is

Fixed rules, strongest evidence first: a pass on retry is **flaky**; an address
that doesn't resolve or refuses, or a browser that won't start, is
**environment**; the test's own `TypeError`/`ReferenceError` and a strict-mode
violation are **test bugs** — all "certain". A locator that found nothing is
judged from the page snapshot: an element of the same kind with a close name
means the locator is out of date (**test bug**, "likely"); nothing like it means
the element is missing (**app bug**, "possible"); the exact element present but
unusable is **unclear**. A value the page showed that the test didn't expect is
an **app bug** — "likely" when an approved test case set the expectation,
otherwise "possible", with the note that the requirement decides; a test that
passed before on the same code drops to "possible", flagged as maybe flaky.

It never proposes changing what a test expects to make it pass; for an app bug
it drafts the bug report, pointing at the test case when there is one.

## 2026-09-24 · A failure suite with an answer key

`demo/failures/` fails on purpose, one test per kind: two planted app bugs
(B3, B7), three test bugs (strict mode, a stale button name, a `TypeError`), a
flaky test and an unreachable service — `stock.invalid`, a reserved name that
can never resolve (port 9 was tried first; Chrome refuses it as an unsafe port,
which isn't the failure meant). The flaky test is simulated — it fails on its
first attempt only — and says so. `demo/answer-key/FAILURES.md` holds the
answers; an integration test requires `report` to match them, on a copy of the
demo and a port of its own. The suite is a Playwright project of its own, out of
`npm test`.

## 2026-09-25 · How `prove` reaches any Playwright project: a wrapper config and a proxy

Measured in a spike on Playwright 1.61.1 before M3 was scoped. Playwright's
`browser_route` belongs to its MCP browser, not to a test run, and a config
can't add routes; so a proof puts a proxy in front of the browser instead.

- **The wrapper.** For the length of a proof, `.proofwright-prove.config.ts`
  sits beside the tester's config, imports it by its full file name, and adds
  `use.proxy` (and `launchOptions.proxy`) to it and to every project. It must sit
  in the same folder: Playwright resolves a config's relative paths (testDir,
  outputDir, webServer's cwd, globalSetup) against the folder of the config it
  loaded. A `.ts` wrapper loads TypeScript, CommonJS `.js` and ESM `.mjs`
  configs alike. It's deleted when the proof ends; one left by a killed proof
  is replaced by the next, which says so. A config with a proxy of its own is
  refused before any test runs.
- **Loopback goes through.** Playwright makes Chromium send even 127.0.0.1
  through a proxy (no `<-loopback>` needed), so local apps are covered.
  Playwright's request fixture tunnels even plain HTTP with CONNECT, so the
  proxy reads plain-HTTP tunnels as well.
- **HTTPS.** A TLS tunnel is opened with a certificate made for its host with
  `openssl` — RSA, because Chromium rejects the EC certificate macOS's LibreSSL
  makes with a TLS "decode error". The browser accepts it only because the
  wrapper sets `ignoreHTTPSErrors` for the proof; the proxy then checks the real
  site's certificate itself (not when the tester's own config ignores HTTPS
  errors). Without openssl, HTTPS passes through unbroken and is named.
- **Claude Code waits.** 2.1.236 gives an MCP tool call about 27 hours, but cuts
  off a stdio server silent for 30 minutes; `prove` sends progress
  notifications when the client asks for them.

## 2026-09-25 · What `prove` breaks, and what counts as noticing

- **API calls only**: any call that changes something (not GET, HEAD or
  OPTIONS), and any GET answered with JSON. Pages, scripts, streams and
  WebSockets pass through. Answers arrive uncompressed (accept-encoding is
  dropped) so JSON can be read.
- **Faults, by default**: every call fails with a server error (500, never
  reaching the app); a read whose answer holds lists answers with them emptied;
  and one run with every answer 1 s late. Broken JSON (`malformed`) is extra:
  it crashes the app for every test at once, so it says little about any one
  test. One run per call and fault, so a proof needs 1 + calls × faults runs;
  above `maxRuns` (40) it stops after the clean run and asks.
- **The clean run** has one worker, no retries and `--forbid-only`: a
  `test.only` would quietly shrink the proof, so it stops and is named. A call
  belongs to the last test that started before it.
- **Fault runs** take only the files whose tests make the call (whole files, so
  serial groups stay whole), the tester's own worker count, traces on, and a
  test timeout of 3× the slowest clean test (at least 10 s, never above the
  tests' own): a fault answers at once, so a test that hasn't noticed by then is
  stuck on a broken page. Playwright's output goes to a folder of the proof's
  own; test-results/ isn't touched.
- **Noticing** is failing on every try while the call is broken; a pass on any
  try means the test can pass with the app broken there. Failing and then
  passing with nothing changed is flaky, and a flaky test isn't proven.
- **Verdicts**: *misses its own action* — first named *passes when its own
  action fails* (it passed while a POST, PUT, PATCH or DELETE it made failed
  with a server error — the colleague's sign-up, add-to-cart and coupon
  tests), *can't fail*, *catches*, or *not proven* with
  the reason. A read it passes through isn't held against it: many pages don't
  need every answer. Failing when a call it doesn't make is broken is noted: it
  depends on another test.
- The answer key was wrong, and is corrected from the measurement: "checkout"
  can fail (its order-number line catches a failed order); "user can sign up"
  was missing.

## 2026-09-25 · Two fixes found while building `prove`

- **`report` said a narrowed run was all clear.** A `test.only` makes
  Playwright run only that test and say nothing of the rest: on the colleague
  project, `report` said "1 test: 1 passed … Nothing failed" for a selection of
  8. It now lists the selection with `--forbid-only` first and, when a `.only`
  narrowed the run, says so in the headline and names the line.
- **A project reached through a symlink didn't know its own files.** Playwright
  names files by their real paths (on macOS, /var is /private/var), so a
  project opened through a symlink got `../../private/…` paths: absolute links
  in `report`, and fault runs that matched no file. The project's folder is now
  its real path.

## 2026-09-25 · What the owner's walkthrough found, and what changed

The owner ran `/proofwright check that coupon codes work at checkout` end to
end in Claude Code. Every change below comes from that run, measured there or
reproduced after it.

- **Claude Code passes a prompt only the first word.** It splits what follows
  the command on spaces and gives each declared argument one word, dropping
  the rest (2.1.236: `split(/\s+/)`, zipped with the argument names). The
  session was told "the tester asked: "check"", the plan was named
  `specs/plan.plan.md`, and the test cases recorded "check" as the request.
  Declaring extra arguments to catch the words would list them all in Claude
  Code's menu ("arguments: request, w2, w3 …"), so the prompt instead tells the
  AI — it sees everything the tester typed — to use their full words, and to
  name the plan from them. Proofwright knows it's Claude Code from the client's
  name (`claude-code`).
- **Expected results never come from the app's code.** The session read the
  shop's `store.mjs`, where three planted bugs live, and started reasoning
  from it. A test whose expected result is read from the code confirms the
  code's bugs. The prompt and the server's instructions now say where expected
  results come from: the request, and what the app promises — named in
  `proofwright/config.json` as `requirements` (the demo: `demo/README.md`).
- **"Not promised" is a question.** Two cases (codes in lower case with spaces;
  a coupon surviving an emptied cart) expected what the page did, which the
  README never promised. The planner is told to start such an expected result
  with "Not promised:", and approve_plan asks the tester about it; approved, the
  mark is dropped from what the generator gets.
- **Values without quotes.** All 23 of approve_plan's questions were false:
  Playwright's planner writes "type SAVE10 into the Coupon code field", and
  only quoted values were read — and "set" in the product name "Pencil set"
  counted as typing. Values are now read after a typing verb at the start of a
  clause ("…, type SAVE10", "and change the quantity to 4", "a made-up code,
  NOPE,"); a phrase that points back at earlier data ("the email used to sign
  up") is a value too; "type a valid email" is still a question. The owner's
  real plan is a test fixture: 21 cases, no questions.
- **Approval is one step, and the form waits 15 minutes.** Claude Code's log
  shows every answer the owner gave: `{"action":"accept","content":{"approve":false}}`
  — Accept, with the box unticked (Enter moves past the box; only Space ticks
  it). The form now has no box: Accept approves, Decline doesn't. And it waited
  60 seconds (the SDK's default) — the first form expired while the owner asked
  how to use it; it now waits 15 minutes and says so plainly when it closes.
- **Cases left out stay out.** Approving some cases leaves the others out on
  purpose: they aren't asked about again, until approved.
- **Short answers.** The owner's team mostly speaks German; the owner asked for
  answers "clear, focused on what's necessary for testers … easy to share with
  developers", with details "when necessary". Every answer now leads with the
  result, then "What to do", then one line on what was done; tables have one
  row per problem that stands on its own. prove's answer was 79,000 characters
  (the session had to query it with jq); it's now under 3,000, with the details
  in the saved report and a small `data` for the client.
- **Rules for the generator.** It wrote a fixed password into four tests (review
  flagged them); the prompt now tells it to create secrets when the test runs,
  to check each approved expected result even when the app disagrees, and to
  wait for each action to finish before checking it.
- **A busy port is said plainly.** prove failed because the generator's session
  left the shop running on 4610. Playwright writes a JSON report even then,
  with the error inside; report and prove now recognise it and say what to do.
- **A test that fails on an app bug isn't something to "fix".** prove told the
  tester to "fix" the two tests failing on real bugs. It now says: find out why
  with explain; if the app is wrong, report the bug, don't change the test.

## 2026-09-25 · prove checks a repeated step: the answers after it, late and different

The walkthrough found a test prove had called good: "re-applying a coupon
changes nothing" checked the discount right after the second "Apply", before
the shop's answer — it read the old, correct value while the shop really
doubles the discount. Breaking every coupon call can't show this: the first
"Apply" fails and the test notices. Measured on the real test before choosing:

- Failing only the 2nd "Apply" (500) doesn't work: the discount stays −€1.20,
  so a good test passes too — it would blame good tests.
- Making only the 2nd answer late and changed doesn't work either: the shop
  reloads the cart after "Apply" and shows that, so a good test ("13. a
  different coupon replaces the applied one", which waits for "WELCOME5
  applied.") passed and was blamed.
- What works: from the 2nd "Apply" on, every JSON answer comes late (1 s) with
  every number changed (+1). The early test still passes (a weakness, reported
  with the step and line); test 13 fails on −€5.01 (good). A test that waits
  only for the Apply answer, not the reload, also passes — and is reported: it
  checks the page before the page's answers arrive.

It runs that test alone (`file:line`), for the 2nd and 3rd time a test repeats
an action. A fault that broke nothing (no JSON after it) counts as not tried.

**Steps by name.** The clean run keeps traces; each test's trace links every
request to the step that made it (test.trace's steps and the network log share
one clock), so findings say `"Apply" (coupons-cart.spec.ts:264)` instead of
`POST /api/cart/coupon`. A trace is read with a small zip reader (no new
dependency); when one can't be read, the call is named instead.

## 2026-09-25 · Guided, step by step: `/proofwright` and `guide`

The owner asked for Proofwright to "become simple and user-friendly, just like
some tools that help guide users through each step".

- **One short command.** `init` adds `/proofwright` to a project
  (`.claude/commands/proofwright.md`): with words, a new guided session; alone,
  where you are and what's next. A command gets the tester's whole sentence
  (`$ARGUMENTS`) — unlike an MCP prompt command, which Claude Code cuts to one
  word. Its `argument-hint` is quoted: Copilot CLI reads Claude's commands too
  and refuses an unquoted `[what to test]` as a list.
- **The guide is a tool, not a file of state.** `guide` reads each session's
  six steps from what's already saved — the plan, the test cases and approvals,
  the approved plan's test files, a review of them, the latest proof — so it
  knows where things stand after a break, a usage limit or a new session, in
  any AI app. Review is advice, not a gate: its problems are listed and the
  guide moves on to prove. With a request, `guide` returns the session's steps
  for the AI (the same text as the prompt), not an answer for the tester.
- **Every answer ends with the next step,** and what to say.

## 2026-09-25 · The Claude desktop app: approval in the chat

Measured in the desktop app 2.9939.2, which runs Claude Code 2.1.281 driven by
the app: Claude Code tells MCP servers it can show forms (`elicitation`), and
passes a form request up to the app — but the app's Code tab gives Claude Code
no form handler, and the SDK then answers every form "decline", unseen. So a
form there would make approval impossible. The desktop app marks the servers
it starts (`CLAUDE_CODE_ENTRYPOINT=claude-desktop`, seen in a server's
environment); there, Proofwright doesn't send the form and takes the tester's
own words, recorded as relayed by the AI client. The app's Code tab loads
project settings (`settingSources: user, project, local`), so `/proofwright`
and Playwright's agents work there.

## 2026-09-25 · GitHub Copilot CLI

Measured with Copilot CLI 1.0.88: it connects to the servers in a project's
`.mcp.json` (the Claude Code format works) once the folder is trusted; it tells
servers it can show forms (`elicitation: form`), introduces itself as
`copilot-cli`, and asks for tools but not prompts; it waited 150 s for one tool
call and sends a progress token, so prove's progress reaches it. It finds
skills in `.github/skills/` (and reads `.claude/`'s commands too).
`init --copilot` installs Playwright's agents for Copilot
(`init-agents --loop=copilot`: `.github/agents/`, `.vscode/mcp.json`), a
Proofwright skill, and Playwright's test server in `.mcp.json`; it removes the
workflow Playwright's Copilot setup adds for Copilot's *cloud* agent
(`.github/workflows/copilot-setup-steps.yml`) — the CLI doesn't need it, and a
workflow shouldn't appear in a repo unasked. A whole walkthrough in Copilot is
still to be tried. Antigravity isn't among Playwright's agent setups
(`claude, codex, copilot, opencode, vscode`); Proofwright's tools work with any
MCP app, but that's untested.

## 2026-09-25 · Small fixes from the second walkthrough

- **A case keeps its number when it's edited.** Numbers were keyed by the
  case's title, so rewording case 17 made it TC-019. A case that's gone from
  the plan and a new one in the same place (same suite and position, or the
  same test file) are the same case, edited: it keeps its number; its approval
  lapses as for any change.
- **Addresses look like addresses.** `test_data` had no address kind; the
  session used "text", whose typical value is a sentence ("Please leave the
  parcel …"). `address` gives street addresses, and the unusual ones (other
  scripts, ß, markup, a line break).
- **The generator's leftover app is stopped before prove** (it blocked prove in
  both walkthroughs), and **steps are what a user can do on the page** — the
  planner had removed a coupon through the API behind the page's back.
- **init** passes the configured project to Playwright's setup (its seed test
  landed in the shop's own tests), and writes `.mcp.json` only when a server
  changes (it reformatted it).


## 2026-09-25 · A proof remembers what it proved

- **Changed since the proof is judged by what's in the files, not their
  times.** The guide said "the tests changed since they were proven" when a
  test file was newer than the proof. But a file can be written again with the
  same text — a `git checkout` or stash, a copy, another tool putting files
  back — and then every test looked changed: after one such rewrite all 17 of
  the second walkthrough's tests did. A proof now keeps each test file's
  fingerprint (the sha256 of its text, in `proof.json` as `files`); the guide
  compares those, and a file the proof didn't run counts as not proven. Proofs
  made before this have no fingerprints: for them the guide still compares
  times. Which session the guide shows first still follows file times — it
  only changes the order.
- **A proof that stops at the start leaves no folder.** prove made its
  `proofwright/runs/proofs/<id>/` folder before the clean run, so a proof
  stopped by a busy port or a `test.only` left it empty. The folder is now
  made when there's something to keep.

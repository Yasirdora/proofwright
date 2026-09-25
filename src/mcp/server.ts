/**
 * The Proofwright MCP server (stdio). Each tool answers in the three-part
 * format (answer.ts) as text for the tester, with the same result as
 * structured content for the client.
 *
 * Tools: `guide`, `review`, `test_data` (M1a), `approve_plan` (M1b), `report`,
 * `explain` (M2), `prove` (M3). Prompt:
 * `proofwright` — the guided session over Playwright's own agents.
 */
import * as fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { type Answer, renderAnswer } from "../answer.js";
import { CHARACTER_KINDS, DataError, FIELD_KINDS, type FieldSpec } from "../data/generate.js";
import { testData } from "../data/tool.js";
import { approvePlan, type AskTester } from "../plan/tool.js";
import { DEFAULT_MAX_RUNS, DEFAULT_SLOW_MS } from "../prove/prove.js";
import { FAULT_KINDS, type FaultKind } from "../prove/proxy.js";
import { proveTool } from "../prove/tool.js";
import { explain, report } from "../runs/tools.js";
import { guide } from "../guide/guide.js";
import { PROMPTS, renderPrompt, sessionText } from "./prompts.js";
import { Project, ProjectError } from "../project.js";
import { review } from "../review/review.js";

export const VERSION: string = JSON.parse(
  fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).version;

const INSTRUCTIONS = `Proofwright works with a human tester on Playwright tests.
Each tool answers with the result first, then "What to do", then one line on what it did. Show the tester that answer as it is, and put the questions in "What to do" to them rather than answering them yourself.
Write to the tester the same way: clear, simple English, short sentences, only what they need to know and what to do. Many testers don't speak English as their first language. Give details when something needs explaining.
Expected results come from the tester's request and from what the app promises (its requirements, its documentation, what a user sees) — never from the app's source code. Don't read the app's code to decide what's right: a test written from the code confirms its bugs.
Never change what a test expects, and never mark anything approved, without the tester's explicit yes: pass approve_plan the tester's own words, exactly as they said them — never your own.
Playwright's own agents explore, write and run (the playwright-test-planner and playwright-test-generator); Proofwright doesn't replace them. Never use the playwright-test-healer: it changes what tests expect to make them pass.
prove runs the tests many times and takes minutes: tell the tester before you call it.
When the tester asks where they are or what's next — or starts a new request — call guide: without a request it gives their status and the next step; with one, the steps of a guided session, which are for you to follow (don't show them to the tester).`;

const ROOT_PROPERTY = {
  type: "string",
  description:
    "Absolute path of the tester's project. Omit it when the server was started in the project (or with --root).",
};

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** An Answer for the tester — or plain text meant for the AI (the guide's session steps). */
  run: (project: Project, args: Record<string, unknown>, ask?: AskTester, progress?: Progress) => Answer | string | Promise<Answer>;
}

type Progress = (message: string, done: number, total: number) => void;

const TOOLS: Tool[] = [
  {
    name: "guide",
    description:
      "Where the tester is, and the one next step. Without a request: every test session's six steps (plan, test cases, approval, tests, review, prove), read from what's saved in the project — so it works after a break or in a new session — and exactly what to say next. With a request (the tester's words): the steps of a new guided session, for you to follow. Reads only; runs and changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string", description: "What the tester wants to test, in their exact words. Omit to get where they are and what's next." },
        root: ROOT_PROPERTY,
      },
      additionalProperties: false,
    },
    run: (project, args) => {
      const request = optional(args.request, "string", "request")?.trim();
      return request ? sessionText(request, project) : guide(project);
    },
  },
  {
    name: "review",
    description:
      "Review Playwright test scripts — the tester's own or a colleague's — against fixed rules: fixed waits, tests with no assertion, expects that are never awaited, forced clicks, fragile selectors, .only/.skip left in, tests that depend on each other, passwords or real personal data written into tests, and retries that hide flaky tests. Reads files only; runs and changes nothing. Returns every finding with file:line, why it matters and what to do instead.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Files or folders to review, relative to the project. Folders contribute their *.spec / *.test files. Omit to review the whole project.",
        },
        root: ROOT_PROPERTY,
      },
      additionalProperties: false,
    },
    run: (project, args) => review(project, stringList(args.paths, "paths")),
  },
  {
    name: "test_data",
    description:
      "Make up test data for a form's fields: typical values, the limits, invalid values, and unusual ones that often break apps (other scripts, right-to-left text, emoji, markup, byte-length limits). Every value is made up and marked with what the app should do with it — accept, refuse, or a question for the tester — worked out only from the rules given. The same seed always gives the same values. Optionally saves them to proofwright/data/<save>.json.",
    inputSchema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          minItems: 1,
          description: "The form's fields and the rules the app should enforce.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "The field's label, as the tester sees it." },
              kind: { type: "string", enum: [...FIELD_KINDS] },
              required: { type: "boolean" },
              minLength: { type: "integer", minimum: 0, description: "In characters." },
              maxLength: { type: "integer", minimum: 0, description: "In characters." },
              min: {
                type: ["number", "string"],
                description: "number: the smallest allowed value. date: the earliest allowed day, YYYY-MM-DD.",
              },
              max: {
                type: ["number", "string"],
                description: "number: the largest allowed value. date: the latest allowed day, YYYY-MM-DD.",
              },
              integer: { type: "boolean", description: "number: whole numbers only." },
              pattern: { type: "string", description: "A regular expression the whole value must match." },
              mustInclude: {
                type: "array",
                items: { type: "string", enum: [...CHARACTER_KINDS] },
                description: "password: kinds of character it must contain.",
              },
              minAge: { type: "integer", minimum: 0, description: "birthDate: the youngest allowed age, in years." },
              maxAge: { type: "integer", minimum: 0, description: "birthDate: the oldest allowed age, in years." },
            },
            required: ["name", "kind"],
            additionalProperties: false,
          },
        },
        seed: { type: "integer", minimum: 0, description: "Same seed, same values. Default 1." },
        today: {
          type: "string",
          description: "YYYY-MM-DD. Birth-date limits are worked out on this day. Default: today.",
        },
        save: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
          description: "Save the data as proofwright/data/<save>.json.",
        },
        root: ROOT_PROPERTY,
      },
      required: ["fields"],
      additionalProperties: false,
    },
    run: (project, args) => {
      if (!Array.isArray(args.fields)) throw new ProjectError("fields must be a list of fields.");
      return testData(project, {
        fields: args.fields as FieldSpec[],
        seed: optional(args.seed, "number", "seed"),
        today: optional(args.today, "string", "today"),
        save: optional(args.save, "string", "save"),
      });
    },
  },
  {
    name: "approve_plan",
    description:
      "Turn the test plan Playwright's planner saved (specs/*.md) into numbered test cases the tester reads — Action · Data · Expected result — list what's open (a case that checks nothing can't be approved; unclear steps are questions), and record the tester's approval, case by case. Only approved cases go on, in a plan of their own for Playwright's generator (specs/<name>.approved.md). Call it without `approve` to show the cases; call it again with `approve` once the tester has said yes. Approval is the tester's: Proofwright asks them directly when this app can show a form; otherwise pass their exact words in `words`.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "The plan Playwright's planner saved, relative to the project, e.g. specs/coupons.plan.md." },
        request: { type: "string", description: "The tester's request, in their own words — kept with the test cases." },
        approve: {
          type: "array",
          items: { type: "string" },
          description: 'Case numbers the tester approved, e.g. ["TC-001", "TC-003"], or ["all"].',
        },
        words: {
          type: "string",
          description: "The tester's own words of approval, exactly as they said them. Needed only when this app can't show Proofwright's approval form.",
        },
        root: ROOT_PROPERTY,
      },
      required: ["plan"],
      additionalProperties: false,
    },
    run: (project, args, ask) => {
      const plan = optional(args.plan, "string", "plan");
      if (!plan) throw new ProjectError("plan is required: the path of the plan Playwright's planner saved.");
      return approvePlan(
        project,
        {
          plan,
          request: optional(args.request, "string", "request"),
          approve: args.approve === undefined ? undefined : stringList(args.approve, "approve"),
          words: optional(args.words, "string", "words"),
        },
        ask,
      );
    },
  },
  {
    name: "report",
    description:
      "The one-page test report. With `run`, it runs Playwright's own runner now (the project's config, plus a JSON report and traces on failure) and keeps the results and the evidence of every failure; with `from`, it reads a Playwright JSON report you already have (from CI); with neither, it reports on the last recorded run. Compares with the run before — new failures, still failing, fixed — and gives each failure a one-line diagnosis: app bug, test bug, flaky or environment, with how sure it is.",
    inputSchema: {
      type: "object",
      properties: {
        run: {
          type: "object",
          description: "Run Playwright's runner now. Leave the object empty to run everything.",
          properties: {
            paths: { type: "array", items: { type: "string" }, description: "Test files or folders, relative to the project." },
            project: { type: "string", description: "A Playwright project name from playwright.config." },
            grep: { type: "string", description: "Only tests whose title matches this." },
            timeoutMinutes: { type: "number", description: "Stop the run after this long. Default 15." },
          },
          additionalProperties: false,
        },
        from: { type: "string", description: "A Playwright JSON report to read instead of running, relative to the project." },
        root: ROOT_PROPERTY,
      },
      additionalProperties: false,
    },
    run: (project, args) => {
      const run = args.run;
      if (run !== undefined && (typeof run !== "object" || run === null || Array.isArray(run))) {
        throw new ProjectError("run must be an object (it can be empty).");
      }
      const r = (run ?? undefined) as Record<string, unknown> | undefined;
      return report(project, {
        ...(r
          ? {
              run: {
                ...(r.paths !== undefined ? { paths: stringList(r.paths, "run.paths") } : {}),
                ...(r.project !== undefined ? { project: optional(r.project, "string", "run.project") } : {}),
                ...(r.grep !== undefined ? { grep: optional(r.grep, "string", "run.grep") } : {}),
                ...(r.timeoutMinutes !== undefined ? { timeoutMinutes: optional(r.timeoutMinutes, "number", "run.timeoutMinutes") } : {}),
              },
            }
          : {}),
        ...(args.from !== undefined ? { from: optional(args.from, "string", "from") } : {}),
      });
    },
  },
  {
    name: "explain",
    description:
      "Explain one failed test from a recorded run: what happened (the failing line, expected and received), the evidence Playwright kept (the page as it was, the screenshot, the trace), the reasoning, how sure it is, and what to do — with a bug report drafted for an app bug. It proposes; it never changes a test, and never proposes changing what a test expects to make it pass.",
    inputSchema: {
      type: "object",
      properties: {
        test: { type: "string", description: "Which failure: part of its title, its test case number (TC-003), or file:line." },
        run: { type: "string", description: "Which recorded run. Default: the last one." },
        root: ROOT_PROPERTY,
      },
      required: ["test"],
      additionalProperties: false,
    },
    run: (project, args) => {
      const test = optional(args.test, "string", "test");
      if (!test) throw new ProjectError("Say which failure to explain: part of its title, its case number, or file:line.");
      return explain(project, { test, ...(args.run !== undefined ? { run: optional(args.run, "string", "run") } : {}) });
    },
  },
  {
    name: "prove",
    description:
      "Prove tests can fail: run them with the app broken on purpose and show which notice. Proofwright runs them once with nothing broken to learn which API calls each test's steps make, then once per call with that call failing (a server error, or empty lists), once with every answer late, and — for a step a test repeats — once with only the repeat's answer late and changed. A test that stays green while its own step fails, or that checks the page before its step's answer arrives, needs a better check; the answer names the step and line, with a screenshot. Works on any Playwright test through a temporary config beside the tester's, without changing their tests or config. Takes minutes: one run per call broken; stops first and asks when it would take more than maxRuns.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Test files or folders, relative to the project. Omit to prove every test." },
        project: { type: "string", description: "A Playwright project name from the config." },
        grep: { type: "string", description: "Only tests whose title matches this." },
        endpoints: {
          type: "array",
          items: { type: "string" },
          description: 'Break only the calls whose name contains one of these, e.g. ["POST /api/cart/coupon"] or ["coupon"]. Omit to break every API call the tests make.',
        },
        faults: {
          type: "array",
          items: { type: "string", enum: [...FAULT_KINDS] },
          description: 'How to break calls. Default ["error", "empty", "slow"]; "malformed" (broken JSON) is extra.',
        },
        maxRuns: { type: "integer", minimum: 1, maximum: 1000, description: `Stop before breaking anything when a proof needs more runs than this. Default ${DEFAULT_MAX_RUNS}.` },
        slowMs: { type: "integer", minimum: 100, maximum: 20000, description: `How late every answer comes in the slow run, in ms. Default ${DEFAULT_SLOW_MS}.` },
        config: { type: "string", description: "The Playwright config the tests use, relative to the project. Default: playwright.config.* at the root." },
        root: ROOT_PROPERTY,
      },
      additionalProperties: false,
    },
    run: (project, args, _ask, progress) => {
      const faults = args.faults === undefined ? undefined : stringList(args.faults, "faults");
      const wrong = faults?.find((f) => !(FAULT_KINDS as readonly string[]).includes(f));
      if (wrong) throw new ProjectError(`"${wrong}" isn't a fault Proofwright knows: ${FAULT_KINDS.join(", ")}.`);
      return proveTool(
        project,
        {
          ...(args.paths !== undefined ? { paths: stringList(args.paths, "paths") } : {}),
          ...(args.project !== undefined ? { project: optional(args.project, "string", "project") } : {}),
          ...(args.grep !== undefined ? { grep: optional(args.grep, "string", "grep") } : {}),
          ...(args.endpoints !== undefined ? { endpoints: stringList(args.endpoints, "endpoints") } : {}),
          ...(faults ? { faults: faults as FaultKind[] } : {}),
          ...(args.maxRuns !== undefined ? { maxRuns: optional(args.maxRuns, "number", "maxRuns") } : {}),
          ...(args.slowMs !== undefined ? { slowMs: optional(args.slowMs, "number", "slowMs") } : {}),
          ...(args.config !== undefined ? { config: optional(args.config, "string", "config") } : {}),
        },
        progress,
      );
    },
  },
];

/** How long the approval form waits for the tester. */
export const FORM_TIMEOUT_MS = 15 * 60_000;

export interface ServerOptions {
  /** How long the approval form waits (tests use a short one). */
  formTimeoutMs?: number;
  /**
   * Running in the Claude desktop app's Code tab, which answers every form "decline"
   * without showing it. Default: what Claude Code tells the servers it starts
   * (CLAUDE_CODE_ENTRYPOINT=claude-desktop).
   */
  desktopApp?: boolean;
}

export function createServer(defaultRoot: string, options: ServerOptions = {}): Server {
  const server = new Server(
    { name: "proofwright", version: VERSION },
    { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS },
  );
  const formTimeoutMs = options.formTimeoutMs ?? FORM_TIMEOUT_MS;
  const desktopApp = options.desktopApp ?? process.env.CLAUDE_CODE_ENTRYPOINT === "claude-desktop";

  /**
   * Ask the tester directly, when the client can show a form (MCP elicitation).
   * One step: Accept approves, Decline doesn't — no box to tick, which testers
   * missed (Accept with the box unticked approved nothing).
   */
  const askTester = (): AskTester | undefined => {
    if (!server.getClientCapabilities()?.elicitation) return undefined;
    // The Claude desktop app's Code tab runs Claude Code, which tells servers it can show
    // forms — but the app answers every form "decline" without showing it (measured in
    // 2.9939.2 / Claude Code 2.1.281). There, the tester approves in the chat, in their words.
    if (desktopApp) return undefined;
    return async (message) => {
      let result;
      try {
        result = await server.elicitInput(
          {
            message,
            requestedSchema: {
              type: "object",
              properties: { words: { type: "string", title: "Anything to add? (optional)" } },
            },
          },
          { timeout: formTimeoutMs },
        );
      } catch (err) {
        if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
          const minutes = Math.round(formTimeoutMs / 60_000);
          const secs = Math.max(1, Math.round(formTimeoutMs / 1000));
          const waited = minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${secs} second${secs === 1 ? "" : "s"}`;
          throw new ProjectError(`The approval form closed after ${waited} without an answer, so nothing was approved. Ask again when you're ready.`);
        }
        throw err;
      }
      if (result.action !== "accept") return null;
      const note = typeof result.content?.words === "string" ? result.content.words.trim() : "";
      return { words: note || "Approved in Proofwright's form." };
    };
  };

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    let project: Project | undefined;
    try {
      project = new Project(defaultRoot);
    } catch {
      project = undefined; // the prompt still works without the project's settings
    }
    return renderPrompt(request.params.name, request.params.arguments ?? {}, project, server.getClientVersion()?.name);
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) return failure(`There is no tool called "${request.params.name}".`);
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    // Long tools say where they are, when the client asked to hear it.
    const token = request.params._meta?.progressToken;
    const progress: Progress | undefined =
      token === undefined
        ? undefined
        : (message, done, total) => {
            void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: done, total, message } }).catch(() => {});
          };
    try {
      const project = new Project(optional(args.root, "string", "root") ?? defaultRoot);
      const answer = await tool.run(project, args, askTester(), progress);
      if (typeof answer === "string") return { content: [{ type: "text", text: answer }] };
      return {
        content: [{ type: "text", text: renderAnswer(answer) }],
        structuredContent: {
          headline: answer.headline,
          did: answer.did,
          need: answer.need,
          data: answer.data as Record<string, unknown>,
        },
      };
    } catch (err) {
      if (err instanceof ProjectError || err instanceof DataError) return failure(err.message);
      return failure(`Something went wrong inside Proofwright: ${(err as Error).message}`);
    }
  });

  return server;
}

export async function serveStdio(defaultRoot: string): Promise<void> {
  const server = createServer(defaultRoot);
  await server.connect(new StdioServerTransport());
}

function failure(message: string) {
  return { isError: true, content: [{ type: "text", text: `**I couldn't do that.** ${message}` }] };
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ProjectError(`${name} must be a list of strings.`);
  }
  return value as string[];
}

function optional<T extends "string" | "number">(
  value: unknown,
  type: T,
  name: string,
): (T extends "string" ? string : number) | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== type) throw new ProjectError(`${name} must be a ${type}.`);
  return value as T extends "string" ? string : number;
}

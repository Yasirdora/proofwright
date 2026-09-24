/**
 * The Proofwright MCP server (stdio). Each tool answers in the three-part
 * format (answer.ts) as text for the tester, with the same result as
 * structured content for the client.
 *
 * Tools: `review`, `test_data` (M1a), `approve_plan` (M1b). Prompt:
 * `proofwright` — the guided session over Playwright's own agents.
 */
import * as fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type Answer, renderAnswer } from "../answer.js";
import { CHARACTER_KINDS, DataError, FIELD_KINDS, type FieldSpec } from "../data/generate.js";
import { testData } from "../data/tool.js";
import { approvePlan, type AskTester } from "../plan/tool.js";
import { PROMPTS, renderPrompt } from "./prompts.js";
import { Project, ProjectError } from "../project.js";
import { review } from "../review/review.js";

export const VERSION: string = JSON.parse(
  fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).version;

const INSTRUCTIONS = `Proofwright works with a human tester on Playwright tests.
Every tool answers in three parts — What I did, What I found, What I need from you — show the tester that answer as it is, and put the questions in "What I need from you" to them rather than answering them yourself.
Never change what a test expects, and never mark anything approved, without the tester's explicit yes: pass approve_plan the tester's own words, exactly as they said them — never your own.
Playwright's own agents explore, write and run (the playwright-test-planner and playwright-test-generator); Proofwright doesn't replace them. Never use the playwright-test-healer: it changes what tests expect to make them pass.`;

const ROOT_PROPERTY = {
  type: "string",
  description:
    "Absolute path of the tester's project. Omit it when the server was started in the project (or with --root).",
};

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (project: Project, args: Record<string, unknown>, ask?: AskTester) => Answer | Promise<Answer>;
}

const TOOLS: Tool[] = [
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
];

export function createServer(defaultRoot: string): Server {
  const server = new Server(
    { name: "proofwright", version: VERSION },
    { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS },
  );

  /** Ask the tester directly, when the client can show a form (MCP elicitation). */
  const askTester = (): AskTester | undefined => {
    if (!server.getClientCapabilities()?.elicitation) return undefined;
    return async (message) => {
      const result = await server.elicitInput({
        message,
        requestedSchema: {
          type: "object",
          properties: {
            approve: { type: "boolean", title: "Approve these test cases as written?", default: false },
            words: { type: "string", title: "Anything to add? (optional)" },
          },
          required: ["approve"],
        },
      });
      if (result.action !== "accept" || result.content?.approve !== true) return null;
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
    return renderPrompt(request.params.name, request.params.arguments ?? {}, project);
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) return failure(`There is no tool called "${request.params.name}".`);
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const project = new Project(optional(args.root, "string", "root") ?? defaultRoot);
      const answer = await tool.run(project, args, askTester());
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
    throw new ProjectError(`${name} must be a list of paths.`);
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

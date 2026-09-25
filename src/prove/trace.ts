/**
 * Which step of a test made each API call — read from the trace Playwright
 * keeps for it — so a proof can say "the 2nd click on "Apply" (line 264)"
 * instead of "POST /api/cart/coupon".
 *
 * A trace is a zip. Its test.trace holds the test's steps (title, time, the
 * line in the test file); its *.network files hold the requests the browser
 * made, on the same clock (measured on Playwright 1.61.1). A request belongs to
 * the last step that started before it. Traces are Playwright's own format, not
 * a promise: if one can't be read, the proof names the calls instead.
 */
import * as fs from "node:fs";
import * as zlib from "node:zlib";
import { endpointOf } from "./proxy.js";

export interface Step {
  /** "click "Apply"" */
  name: string;
  /** Absolute path of the test file, and the line. */
  file: string;
  line: number;
}

export interface TracedCall {
  endpoint: string;
  step?: Step;
}

/** The files in a zip, by name (only those `want` accepts). */
export function readZip(file: string, want: (name: string) => boolean): Map<string, Buffer> {
  const zip = fs.readFileSync(file);
  const out = new Map<string, Buffer>();
  // The end-of-central-directory record: the last 22+ bytes, found by its signature.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const entries = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("broken zip directory");
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (!want(name)) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
  }
  return out;
}

function lines(buf: Buffer | undefined): Array<Record<string, unknown>> {
  if (!buf) return [];
  return buf
    .toString("utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l) as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
}

/**
 * A step's title as a tester says it: "Click getByRole('button', { name: 'Apply' })"
 * → `click "Apply"`; `Click "text=Create account"` → `click "Create account"`;
 * "Click locator('#app > ul > li')" → `click "#app > ul > li"`.
 */
export function stepName(title: string): string {
  const verb = (/^([A-Za-z]+)/.exec(title)?.[1] ?? "").toLowerCase();
  if (verb === "navigate") return `open ${/"([^"]*)"/.exec(title)?.[1] ?? "the page"}`;
  const target =
    /name: ['"]([^'"]+)['"]/.exec(title)?.[1] ??
    /getBy(?:Text|Label|Placeholder|TestId|Title|AltText)\(['"]([^'"]+)['"]/.exec(title)?.[1] ??
    /locator\(['"]([^'"]+)['"]\)/.exec(title)?.[1] ??
    /"([^"]+)"/.exec(title)?.[1];
  return target ? `${verb} "${target.replace(/^text=/, "")}"` : title;
}

/**
 * The API calls in a test's trace, in order, each with the step that made it.
 * `isTestFile` keeps to steps written in the tests (not fixtures or helpers
 * from node_modules).
 */
export function tracedCalls(traceZip: string, isTestFile: (abs: string) => boolean): TracedCall[] {
  const files = readZip(traceZip, (n) => n === "test.trace" || /(^|\/)\d*-?trace\.network$/.test(n));
  const steps: Array<Step & { at: number }> = [];
  for (const e of lines(files.get("test.trace"))) {
    if (e.type !== "before" || typeof e.callId !== "string" || !e.callId.startsWith("pw:api")) continue;
    const frame = ((e.stack as Array<{ file?: string; line?: number }>) ?? []).find((f) => f.file && isTestFile(f.file));
    if (!frame?.file || !frame.line || typeof e.startTime !== "number") continue;
    steps.push({ name: stepName(String(e.title ?? "")), file: frame.file, line: frame.line, at: e.startTime });
  }
  steps.sort((a, b) => a.at - b.at);
  const requests: Array<{ endpoint: string; at: number }> = [];
  for (const [name, buf] of files) {
    if (name === "test.trace") continue;
    for (const e of lines(buf)) {
      const snap = e.snapshot as { request?: { method?: string; url?: string }; _monotonicTime?: number } | undefined;
      if (e.type !== "resource-snapshot" || !snap?.request?.url || typeof snap._monotonicTime !== "number") continue;
      try {
        const url = new URL(snap.request.url);
        requests.push({ endpoint: endpointOf((snap.request.method ?? "GET").toUpperCase(), url.host, url.pathname), at: snap._monotonicTime });
      } catch {
        // not a URL we can name
      }
    }
  }
  requests.sort((a, b) => a.at - b.at);
  return requests.map((r) => {
    const step = [...steps].reverse().find((s) => s.at <= r.at);
    return { endpoint: r.endpoint, ...(step ? { step: { name: step.name, file: step.file, line: step.line } } : {}) };
  });
}

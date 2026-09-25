/**
 * The fault proxy: a local HTTP proxy that a proof's browser sends its traffic
 * through, and that breaks API calls on purpose.
 *
 * Playwright points the browser at it (`use.proxy`, set by the wrapper config),
 * and Playwright makes Chromium send even 127.0.0.1 through a proxy. Plain HTTP
 * arrives as proxy requests; HTTPS, WebSockets and Playwright's own request
 * fixture arrive as CONNECT tunnels. A tunnel that carries TLS is opened with a
 * certificate made for its host on the spot (openssl, RSA — Chromium refuses
 * the EC certificates macOS's LibreSSL makes). The browser accepts it for the
 * proof only (`ignoreHTTPSErrors`), and the proxy checks the real site's
 * certificate itself. Without openssl, TLS tunnels pass through untouched and
 * the proof names the hosts it couldn't break.
 *
 * Every call is logged. A call is an API call when it changes something (any
 * method but GET, HEAD and OPTIONS) or is answered with JSON, and only API
 * calls are ever broken. Everything else (pages, scripts, images, streams,
 * WebSockets) passes through as it came.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Duplex } from "node:stream";
import * as tls from "node:tls";
import * as zlib from "node:zlib";

/** The faults a tester can ask for. */
export const FAULT_KINDS = ["error", "empty", "malformed", "slow"] as const;
/**
 * Plus one a proof uses on its own: "changed" — from the 2nd (3rd …) time a
 * test repeats an action on, every JSON answer arrives late with every number
 * in it changed: the action's own answer and the ones after it (an app often
 * reloads what it shows, like the cart after "Apply"). A test that checks the
 * page before those answers arrive still passes; one that waits for them sees
 * different numbers and fails.
 */
export type FaultKind = (typeof FAULT_KINDS)[number] | "changed";

export interface Fault {
  kind: FaultKind;
  /** The endpoints to break (`Call.endpoint`); every API call when absent. */
  endpoints?: string[];
  /** Only the n-th call to those endpoints since the fault was set (1 = the first) — for
   *  "changed": that call and every JSON answer after it. */
  nth?: number;
  /** slow, changed: how late each answer arrives. Default 1000. */
  delayMs?: number;
}

export interface Call {
  /** When the proxy received it (ms since the epoch). */
  at: number;
  method: string;
  /** "METHOD host/path", with ids in the path as :id. */
  endpoint: string;
  host: string;
  path: string;
  /** Changes something: any method but GET, HEAD and OPTIONS. */
  action: boolean;
  /** Answered with JSON. */
  json: boolean;
  /** The JSON answer holds a list somewhere. */
  lists: boolean;
  /** The JSON answer holds a number somewhere (so "changed" can change it). */
  numbers: boolean;
  status: number;
  https: boolean;
  /** The fault this call got, if it got one. */
  broken?: FaultKind;
  /** Its place among the calls the fault names (1 = the first). */
  nth?: number;
}

export interface FaultProxy {
  /** http://127.0.0.1:<port> */
  url: string;
  calls: Call[];
  fault: Fault | undefined;
  /** Whether TLS tunnels are opened (openssl could make a certificate). */
  opensHttps: boolean;
  /** Hosts whose HTTPS passed through untouched, because TLS tunnels couldn't be opened. */
  passedThrough: Set<string>;
  /** Hosts whose real certificate failed the proxy's check. */
  untrusted: Set<string>;
  close(): Promise<void>;
}

export interface ProxyOptions {
  /** Check real sites' certificates. Default: yes. (No when the tester's own config ignores HTTPS errors.) */
  verify?: () => boolean;
  /** Open TLS tunnels. Default: when openssl can make a certificate. */
  https?: boolean;
}

const BROKEN_JSON = '{"proofwright": "this answer was broken on purpose';
const ERROR_BODY = JSON.stringify({ error: "Proofwright broke this call on purpose: a server error." });

/** Path segments that are ids: 1042, UUIDs, long hex, PW-1042 / ord_10423. */
const ID_SEGMENT = [/^\d+$/, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, /^[0-9a-f]{16,}$/i, /^[a-z]{1,6}[-_]?\d{3,}$/i];

/** "GET", "127.0.0.1:4610", "/api/orders/PW-1042" → "GET 127.0.0.1:4610/api/orders/:id". */
export function endpointOf(method: string, host: string, pathname: string): string {
  const p = pathname
    .split("/")
    .map((seg) => (seg && ID_SEGMENT.some((re) => re.test(seg)) ? ":id" : seg))
    .join("/");
  return `${method} ${host}${p}`;
}

export const isAction = (method: string) => !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
/** application/json, application/problem+json, text/json — not application/x-ndjson, which streams. */
export const isJson = (contentType: string) => /[/+]json\s*(;|$)/i.test(contentType);

/** Every number in a JSON value changed (+1); everything else as it was. Undefined when there's none. */
export function renumbered(v: unknown): unknown {
  let found = false;
  const walk = (x: unknown): unknown => {
    if (typeof x === "number") {
      found = true;
      return x + 1;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  const out = walk(v);
  return found ? out : undefined;
}

/** Every list in a JSON value emptied; everything else as it was. */
export function emptied(v: unknown): unknown {
  if (Array.isArray(v)) return [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, emptied(x)]));
  return v;
}

export function hasList(v: unknown): boolean {
  if (Array.isArray(v)) return true;
  return !!v && typeof v === "object" && Object.values(v).some(hasList);
}

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"];

function requestHeaders(h: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...h };
  for (const k of HOP_BY_HOP) delete out[k];
  // Uncompressed answers, so a JSON answer can be read and broken.
  delete out["accept-encoding"];
  return out;
}

function responseHeaders(h: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...h };
  for (const k of HOP_BY_HOP) delete out[k];
  return out;
}

function decoded(raw: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? "").toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(raw);
    case "br":
      return zlib.brotliDecompressSync(raw);
    case "deflate":
      return zlib.inflateSync(raw);
    default:
      return raw;
  }
}

function isCertificateError(err: NodeJS.ErrnoException): boolean {
  return /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ALTNAME/i.test(err.code ?? "") || /certificate/i.test(err.message);
}

/** A socket's data as a stream again, with the bytes already read put back in front. */
function replay(socket: net.Socket, first: Buffer): Duplex {
  const stream = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk: Buffer, _encoding, done) {
      socket.write(chunk, (err) => done(err ?? null));
    },
    final(done) {
      socket.end();
      done();
    },
    destroy(err, done) {
      socket.destroy();
      done(err);
    },
  });
  stream.push(first);
  socket.on("data", (chunk: Buffer) => {
    if (!stream.push(chunk)) socket.pause();
  });
  socket.on("end", () => stream.push(null));
  socket.on("close", () => stream.destroy());
  return stream;
}

/** Certificates for the hosts whose TLS the proxy opens, made with openssl and kept for the proof. */
class Certificates {
  private readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-certs-"));
  private readonly made = new Map<string, tls.SecureContext | null>();

  /** Undefined when openssl isn't there or can't make one. */
  static create(): Certificates | undefined {
    const certs = new Certificates();
    if (certs.contextFor("localhost")) return certs;
    certs.dispose();
    return undefined;
  }

  contextFor(host: string): tls.SecureContext | undefined {
    if (!this.made.has(host)) this.made.set(host, this.make(host));
    return this.made.get(host) ?? undefined;
  }

  private make(host: string): tls.SecureContext | null {
    const base = path.join(this.dir, String(this.made.size));
    try {
      execFileSync(
        "openssl",
        [
          "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
          "-subj", "/CN=Proofwright proof",
          "-addext", `subjectAltName=${net.isIP(host) ? "IP" : "DNS"}:${host}`,
          "-keyout", `${base}.key`, "-out", `${base}.crt`,
        ],
        { stdio: "ignore", timeout: 20_000 },
      );
      return tls.createSecureContext({ key: fs.readFileSync(`${base}.key`), cert: fs.readFileSync(`${base}.crt`) });
    } catch {
      return null;
    }
  }

  dispose(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

export async function startProxy(options: ProxyOptions = {}): Promise<FaultProxy> {
  const verify = options.verify ?? (() => true);
  const certs = options.https === false ? undefined : Certificates.create();
  const sockets = new Set<net.Socket | Duplex>();
  /** Where a tunnelled connection goes: "https://host:port". */
  const origins = new WeakMap<object, string>();

  const state: FaultProxy = {
    url: "",
    calls: [],
    fault: undefined,
    opensHttps: certs !== undefined,
    passedThrough: new Set(),
    untrusted: new Set(),
    close: async () => {
      for (const s of sockets) s.destroy();
      await Promise.all([new Promise((r) => outer.close(r)), new Promise((r) => inner.close(r))]);
      certs?.dispose();
    },
  };

  /** "changed" has started: its n-th call came, and every JSON answer since is changed. */
  let changing: Fault | undefined;
  const breaks = (call: Call, kinds: FaultKind[]): FaultKind | undefined => {
    const f = state.fault;
    if (!f || !kinds.includes(f.kind)) return undefined;
    if (f.kind === "changed" && changing === f) return f.kind;
    if (f.endpoints !== undefined && !f.endpoints.includes(call.endpoint)) return undefined;
    if (f.nth !== undefined && call.nth !== f.nth) return undefined;
    if (f.kind === "changed") changing = f;
    return f.kind;
  };
  /** How many calls the current fault's endpoints have had. */
  let counted: Fault | undefined;
  let count = 0;

  function handle(req: http.IncomingMessage, res: http.ServerResponse, origin?: string): void {
    let url: URL;
    try {
      url = new URL(req.url ?? "", origin);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Proofwright's proxy takes proxy requests only.");
      return;
    }
    const secure = url.protocol === "https:";
    const method = (req.method ?? "GET").toUpperCase();
    const call: Call = {
      at: Date.now(),
      method,
      endpoint: endpointOf(method, url.host, url.pathname),
      host: url.host,
      path: url.pathname,
      action: isAction(method),
      json: false,
      lists: false,
      numbers: false,
      status: 0,
      https: secure,
    };
    state.calls.push(call);
    if (state.fault?.endpoints?.includes(call.endpoint)) {
      if (counted !== state.fault) [counted, count] = [state.fault, 0];
      call.nth = ++count;
    }

    // A server error: the call never reaches the app, as if its server had failed.
    // Only a named endpoint gets it — every one of those was an API call in the clean run.
    if (breaks(call, ["error"]) && state.fault?.endpoints) {
      req.resume();
      Object.assign(call, { status: 500, json: true, broken: "error" });
      res.writeHead(500, { "content-type": "application/json", "content-length": Buffer.byteLength(ERROR_BODY) });
      res.end(ERROR_BODY);
      return;
    }

    const upstream = (secure ? https : http).request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (secure ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: requestHeaders(req.headers),
        ...(secure ? { rejectUnauthorized: verify(), ...(net.isIP(url.hostname) ? {} : { servername: url.hostname }) } : {}),
      },
      (answer) => respond(call, answer, res),
    );
    upstream.on("error", (err: NodeJS.ErrnoException) => {
      if (secure && isCertificateError(err)) state.untrusted.add(url.host);
      call.status = 502;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`Proofwright's proxy couldn't reach ${url.host}: ${err.message}`);
    });
    req.pipe(upstream);
  }

  function respond(call: Call, answer: http.IncomingMessage, res: http.ServerResponse): void {
    call.status = answer.statusCode ?? 502;
    call.json = isJson(String(answer.headers["content-type"] ?? ""));
    const api = call.action || call.json;
    const slow = api ? breaks(call, ["slow"]) : undefined;
    const changing = call.json ? breaks(call, ["changed"]) : undefined;
    const delay = slow || changing ? (state.fault?.delayMs ?? 1000) : 0;
    if (slow) call.broken = "slow";
    const later = (send: () => void) => (delay > 0 ? setTimeout(send, delay) : send());

    if (!call.json) {
      // Pages, scripts, streams: passed through as they come.
      later(() => {
        res.writeHead(call.status, responseHeaders(answer.headers));
        answer.pipe(res);
      });
      return;
    }

    const chunks: Buffer[] = [];
    answer.on("data", (c: Buffer) => chunks.push(c));
    answer.on("error", () => res.destroy());
    answer.on("end", () => {
      const raw = Buffer.concat(chunks);
      let parsed: unknown;
      let readable = false;
      try {
        parsed = JSON.parse(decoded(raw, answer.headers["content-encoding"] as string | undefined).toString("utf8"));
        readable = true;
      } catch {
        // Not JSON after all, or empty (a HEAD): passed through as it came.
      }
      if (readable) {
        call.lists = hasList(parsed);
        call.numbers = renumbered(parsed) !== undefined;
      }

      let body: Buffer | undefined;
      const kind = breaks(call, ["empty", "malformed", "changed"]);
      if (kind === "empty" && readable && call.lists) body = Buffer.from(JSON.stringify(emptied(parsed)));
      if (kind === "malformed") body = Buffer.from(BROKEN_JSON);
      const changed = kind === "changed" && readable ? renumbered(parsed) : undefined;
      if (changed !== undefined) body = Buffer.from(JSON.stringify(changed));
      if (body) call.broken = kind;

      const headers = responseHeaders(answer.headers);
      if (body) delete headers["content-encoding"];
      headers["content-length"] = String((body ?? raw).length);
      later(() => {
        res.writeHead(call.status, headers);
        res.end(body ?? raw);
      });
    });
  }

  /** A WebSocket (or any upgrade) goes straight through to its server. */
  function upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, origin?: string): void {
    let url: URL;
    try {
      url = new URL(req.url ?? "", origin);
    } catch {
      socket.destroy();
      return;
    }
    const secure = url.protocol === "https:" || url.protocol === "wss:";
    const port = Number(url.port || (secure ? 443 : 80));
    const target = secure
      ? tls.connect({ host: url.hostname, port, rejectUnauthorized: verify(), ...(net.isIP(url.hostname) ? {} : { servername: url.hostname }) })
      : net.connect(port, url.hostname);
    sockets.add(target);
    target.on(secure ? "secureConnect" : "connect", () => {
      const lines = [`${req.method} ${url.pathname}${url.search} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (!/^proxy-/i.test(req.rawHeaders[i])) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      target.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on("error", () => socket.destroy());
    target.on("close", () => sockets.delete(target));
    socket.on("error", () => target.destroy());
  }

  const inner = http.createServer((req, res) => handle(req, res, origins.get(req.socket)));
  inner.on("upgrade", (req, socket, head) => upgrade(req, socket, head, origins.get(req.socket)));
  inner.on("clientError", (_err, socket) => socket.destroy());

  const outer = http.createServer((req, res) => handle(req, res));
  outer.on("upgrade", (req, socket, head) => upgrade(req, socket, head));
  outer.on("clientError", (_err, socket) => socket.destroy());
  outer.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  outer.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const target = req.url ?? "";
    const { hostname, port } = new URL(`http://${target}`);
    socket.on("error", () => socket.destroy());
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const open = (first: Buffer) => {
      socket.pause();
      if (first[0] !== 0x16) {
        // Plain HTTP in a tunnel: Playwright's request fixture, a ws:// socket.
        const stream = replay(socket, first);
        origins.set(stream, `http://${target}`);
        inner.emit("connection", stream);
        return;
      }
      const context = certs?.contextFor(hostname.replace(/^\[|\]$/g, ""));
      if (!context) {
        state.passedThrough.add(target);
        const through = net.connect(Number(port || 443), hostname.replace(/^\[|\]$/g, ""), () => {
          through.write(first);
          socket.pipe(through).pipe(socket);
        });
        sockets.add(through);
        through.on("error", () => socket.destroy());
        through.on("close", () => sockets.delete(through));
        return;
      }
      const secure = new tls.TLSSocket(replay(socket, first), { isServer: true, secureContext: context, ALPNProtocols: ["http/1.1"] });
      secure.on("error", () => socket.destroy());
      origins.set(secure, `https://${target}`);
      inner.emit("connection", secure);
    };
    if (head.length > 0) open(head);
    else socket.once("data", open);
  });

  await new Promise<void>((resolve) => outer.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(outer.address() as net.AddressInfo).port}`;
  return state;
}

/**
 * The fault proxy, against a small app of its own: each fault, what passes
 * through untouched, tunnels, HTTPS and WebSockets.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import * as tls from "node:tls";
import * as zlib from "node:zlib";
import { emptied, endpointOf, type FaultProxy, hasList, isJson, renumbered, startProxy } from "../src/prove/proxy.js";

test("endpoints: ids in the path become :id; the rest stays", () => {
  assert.equal(endpointOf("GET", "127.0.0.1:4610", "/api/orders/PW-1042"), "GET 127.0.0.1:4610/api/orders/:id");
  assert.equal(endpointOf("DELETE", "h", "/api/cart/items/1042"), "DELETE h/api/cart/items/:id");
  assert.equal(endpointOf("GET", "h", "/api/users/3f2b8c1e-9a7d-4c21-b0e4-5d6f7a8b9c0d"), "GET h/api/users/:id");
  assert.equal(endpointOf("GET", "h", "/api/v1/products/blue-mug"), "GET h/api/v1/products/blue-mug");
  assert.ok(isJson("application/json; charset=utf-8") && isJson("application/problem+json") && isJson("text/json"));
  assert.ok(!isJson("application/x-ndjson") && !isJson("text/html"));
  assert.deepEqual(emptied({ items: [1, 2], total: 2, nested: { tags: ["a"] } }), { items: [], total: 2, nested: { tags: [] } });
  assert.ok(hasList({ a: { b: [] } }) && !hasList({ a: 1 }));
  assert.deepEqual(renumbered({ discountCents: 120, lines: [{ qty: 1, name: "Blue mug" }], ok: true }), { discountCents: 121, lines: [{ qty: 2, name: "Blue mug" }], ok: true });
  assert.equal(renumbered({ error: "This coupon code isn't valid" }), undefined, "nothing to change");
});

test("proxy: a repeated step — its 2nd answer and every answer after it come late and different; the 1st doesn't", async () => {
  const app = await startApp();
  const proxy = await startProxy({ https: false });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    proxy.fault = { kind: "changed", endpoints: [`POST 127.0.0.1:${app.port}/api/items`], nth: 2, delayMs: 300 };
    const first = await viaProxy(proxy, `${base}/api/items`, "POST");
    assert.deepEqual([JSON.parse(first.body), first.totalMs < 250], [{ ok: true }, true], "the 1st is untouched");
    assert.deepEqual(JSON.parse((await viaProxy(proxy, `${base}/api/items`)).body), { items: [1, 2], total: 2 }, "nor what comes between");
    const second = await viaProxy(proxy, `${base}/api/items`, "POST");
    assert.deepEqual(JSON.parse(second.body), { ok: true }, "no number to change in it: passed on as it is");
    const after = await viaProxy(proxy, `${base}/api/items`);
    assert.deepEqual(JSON.parse(after.body), { items: [2, 3], total: 3 }, "what the app reloads after it is changed");
    assert.ok(after.totalMs >= 290, `and late: ${after.totalMs} ms`);
    assert.ok((await viaProxy(proxy, `${base}/page`)).totalMs < 250, "pages aren't touched");
    assert.deepEqual(proxy.calls.filter((c) => c.broken).map((c) => c.endpoint.split(" ")[0]), ["GET"]);
  } finally {
    await proxy.close();
    app.close();
  }
});

// ---------------------------------------------------------------- a small app

interface App {
  port: number;
  posts: number;
  headers: http.IncomingHttpHeaders[];
  close(): void;
}

function handler(app: App) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    app.headers.push(req.headers);
    const json = (body: unknown, extra: http.OutgoingHttpHeaders = {}) => {
      res.writeHead(200, { "content-type": "application/json", ...extra });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/api/items") {
      app.posts++;
      req.resume();
      return json({ ok: true });
    }
    if (req.url === "/api/items") return json({ items: [1, 2], total: 2 });
    if (req.url === "/api/gz") {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      return res.end(zlib.gzipSync(JSON.stringify({ items: ["x"] })));
    }
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => res.end("data: second\n\n"), 1000);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h1>page</h1>");
  };
}

async function startApp(options?: { key: Buffer; cert: Buffer }): Promise<App> {
  const app: App = { port: 0, posts: 0, headers: [], close: () => {} };
  const server = options ? https.createServer(options, handler(app)) : http.createServer(handler(app));
  // An upgrade gets its 101 and an echo, as a WebSocket server would.
  server.on("upgrade", (_req, socket: net.Socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(d));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  app.port = (server.address() as net.AddressInfo).port;
  app.close = () => {
    server.closeAllConnections();
    server.close();
  };
  return app;
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** ms from sending to the first byte of the body, and to the end. */
  firstByteMs: number;
  totalMs: number;
}

function read(res: http.IncomingMessage, t0: number): Promise<Answer> {
  return new Promise((resolve) => {
    let firstByteMs = -1;
    let body = "";
    res.on("data", (d: Buffer) => {
      if (firstByteMs < 0) firstByteMs = Date.now() - t0;
      body += d.toString("utf8");
    });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, firstByteMs, totalMs: Date.now() - t0 }));
  });
}

/** A request the way a browser sends it to an HTTP proxy: the whole URL as the path. */
function viaProxy(proxy: FaultProxy, url: string, method = "GET"): Promise<Answer> {
  const p = new URL(proxy.url);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: p.hostname, port: p.port, method, path: url, headers: { "accept-encoding": "gzip, br" } }, (res) =>
      resolve(read(res, t0)),
    );
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

/** A CONNECT tunnel to host:port, the way Playwright's request fixture and HTTPS go. */
function tunnel(proxy: FaultProxy, target: string): Promise<net.Socket> {
  const p = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: p.hostname, port: p.port, method: "CONNECT", path: target });
    req.on("connect", (res, socket) => (res.statusCode === 200 ? resolve(socket) : reject(new Error(`CONNECT ${res.statusCode}`))));
    req.on("error", reject);
    req.end();
  });
}

function overSocket(socket: net.Socket | tls.TLSSocket, pathname: string, method = "GET"): Promise<Answer> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request({ createConnection: () => socket, path: pathname, method, host: "127.0.0.1" }, (res) => resolve(read(res, t0)));
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------- plain HTTP

test("proxy: passes everything through untouched when nothing is broken, and logs the API calls", async () => {
  const app = await startApp();
  const proxy = await startProxy({ https: false });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const r = await viaProxy(proxy, `${base}/api/items`);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { items: [1, 2], total: 2 });
    await viaProxy(proxy, `${base}/page`);
    await viaProxy(proxy, `${base}/api/items`, "POST");
    assert.equal(app.posts, 1);
    const calls = proxy.calls.map((c) => [c.endpoint, c.json, c.lists, c.action, c.status]);
    assert.deepEqual(calls, [
      [`GET 127.0.0.1:${app.port}/api/items`, true, true, false, 200],
      [`GET 127.0.0.1:${app.port}/page`, false, false, false, 200],
      [`POST 127.0.0.1:${app.port}/api/items`, true, false, true, 200],
    ]);
    // The app never sees accept-encoding, so JSON answers arrive readable.
    assert.ok(app.headers.every((h) => h["accept-encoding"] === undefined));
    // A compressed answer is still read.
    await viaProxy(proxy, `${base}/api/gz`);
    assert.equal(proxy.calls.at(-1)?.lists, true);
    // A stream isn't held back: its first part arrives long before the app sends the last (1 s later).
    const s = await viaProxy(proxy, `${base}/stream`);
    assert.ok(s.totalMs - s.firstByteMs >= 500, `first ${s.firstByteMs} ms, total ${s.totalMs} ms`);
    assert.equal(s.body, "data: first\n\ndata: second\n\n");
  } finally {
    await proxy.close();
    app.close();
  }
});

test("proxy: each fault breaks the call it names, and nothing else", async () => {
  const app = await startApp();
  const proxy = await startProxy({ https: false });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const host = `127.0.0.1:${app.port}`;

    // A server error: the call never reaches the app.
    proxy.fault = { kind: "error", endpoints: [`POST ${host}/api/items`] };
    const e = await viaProxy(proxy, `${base}/api/items`, "POST");
    assert.equal(e.status, 500);
    assert.match(JSON.parse(e.body).error, /Proofwright broke this call on purpose/);
    assert.equal(app.posts, 0);
    assert.equal((await viaProxy(proxy, `${base}/api/items`)).status, 200, "a GET to the same path isn't that endpoint");
    assert.equal(proxy.calls.filter((c) => c.broken === "error").length, 1);

    proxy.fault = { kind: "empty", endpoints: [`GET ${host}/api/items`] };
    assert.deepEqual(JSON.parse((await viaProxy(proxy, `${base}/api/items`)).body), { items: [], total: 2 });
    proxy.fault = { kind: "empty", endpoints: [`GET ${host}/api/gz`] };
    const gz = await viaProxy(proxy, `${base}/api/gz`);
    assert.deepEqual(JSON.parse(gz.body), { items: [] });
    assert.equal(gz.headers["content-encoding"], undefined);

    proxy.fault = { kind: "malformed", endpoints: [`GET ${host}/api/items`] };
    const m = await viaProxy(proxy, `${base}/api/items`);
    assert.equal(m.status, 200);
    assert.throws(() => JSON.parse(m.body));

    // Late answers: every API call, and only API calls.
    proxy.fault = { kind: "slow", delayMs: 1000 };
    const late = await viaProxy(proxy, `${base}/api/items`);
    assert.ok(late.totalMs >= 990, `${late.totalMs} ms`);
    const page = await viaProxy(proxy, `${base}/page`);
    assert.ok(page.totalMs < late.totalMs - 500, `the page took ${page.totalMs} ms`);
    assert.ok((await viaProxy(proxy, `${base}/api/items`, "POST")).totalMs >= 990);

    proxy.fault = undefined;
    assert.deepEqual(JSON.parse((await viaProxy(proxy, `${base}/api/items`)).body), { items: [1, 2], total: 2 });
  } finally {
    await proxy.close();
    app.close();
  }
});

test("proxy: a plain-HTTP tunnel (Playwright's request fixture) is read and broken like any call; upgrades pass through", async () => {
  const app = await startApp();
  const proxy = await startProxy({ https: false });
  try {
    const host = `127.0.0.1:${app.port}`;
    proxy.fault = { kind: "error", endpoints: [`GET ${host}/api/items`] };
    assert.equal((await overSocket(await tunnel(proxy, host), "/api/items")).status, 500);
    assert.equal(proxy.calls.at(-1)?.endpoint, `GET ${host}/api/items`);

    const socket = await tunnel(proxy, host);
    const echoed = await new Promise<string>((resolve) => {
      let got = "";
      socket.on("data", (d: Buffer) => {
        got += d.toString("utf8");
        if (got.includes("\r\n\r\n") && !got.endsWith("\r\n\r\n")) resolve(got);
        else if (got.includes("\r\n\r\n")) socket.write("ping");
      });
      socket.write(`GET /ws HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n`);
    });
    assert.match(echoed, /^HTTP\/1\.1 101/);
    assert.ok(echoed.endsWith("ping"));
    socket.destroy();
  } finally {
    await proxy.close();
    app.close();
  }
});

// ---------------------------------------------------------------- HTTPS

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function certificate(): { key: Buffer; cert: Buffer } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-cert-"));
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=app", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", `${dir}/k`, "-out", `${dir}/c`],
    { stdio: "ignore" },
  );
  return { key: fs.readFileSync(`${dir}/k`), cert: fs.readFileSync(`${dir}/c`) };
}

async function overTls(proxy: FaultProxy, host: string, pathname: string): Promise<{ answer: Answer; peer: tls.PeerCertificate }> {
  const socket = tls.connect({ socket: await tunnel(proxy, host), rejectUnauthorized: false });
  await new Promise((r) => socket.once("secureConnect", r));
  const peer = socket.getPeerCertificate();
  return { answer: await overSocket(socket, pathname), peer };
}

test("proxy: HTTPS is opened with a certificate of its own, and the real site's certificate is still checked", { skip: !hasOpenssl() && "openssl isn't installed" }, async () => {
  const own = certificate();
  const app = await startApp(own);
  const host = `127.0.0.1:${app.port}`;
  const appFingerprint = new (await import("node:crypto")).X509Certificate(own.cert).fingerprint256;
  try {
    // The app's certificate is one nobody vouches for: checked, it's refused.
    const checking = await startProxy();
    try {
      assert.ok(checking.opensHttps);
      const { answer, peer } = await overTls(checking, host, "/api/items");
      assert.notEqual(peer.fingerprint256, appFingerprint, "the browser sees the proxy's certificate");
      assert.equal(answer.status, 502);
      assert.deepEqual([...checking.untrusted], [host]);
    } finally {
      await checking.close();
    }

    // When the tester's config accepts any certificate, so does the proxy — and it breaks calls.
    const trusting = await startProxy({ verify: () => false });
    try {
      assert.equal((await overTls(trusting, host, "/api/items")).answer.status, 200);
      trusting.fault = { kind: "error", endpoints: [`GET ${host}/api/items`] };
      assert.equal((await overTls(trusting, host, "/api/items")).answer.status, 500);
      assert.ok(trusting.calls.every((c) => c.https));
    } finally {
      await trusting.close();
    }

    // Without certificates, HTTPS passes through untouched — the app's own certificate, unbroken.
    const blind = await startProxy({ https: false });
    try {
      blind.fault = { kind: "error", endpoints: [`GET ${host}/api/items`] };
      const { answer, peer } = await overTls(blind, host, "/api/items");
      assert.equal(peer.fingerprint256, appFingerprint);
      assert.equal(answer.status, 200);
      assert.deepEqual([...blind.passedThrough], [host]);
      assert.equal(blind.calls.length, 0);
    } finally {
      await blind.close();
    }
  } finally {
    app.close();
  }
});

// @ts-check
/**
 * Proofwright Shop — the demo web shop Proofwright is built and measured
 * against. One command, no dependencies:
 *
 *   node demo/shop/server.mjs          (PORT=4610 by default, 127.0.0.1 only)
 *
 * Serves the page from public/ and a small JSON API under /api. Sessions are a
 * cookie; all state is in memory and resets on restart.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ShopError, Store } from "./store.mjs";

const PORT = Number(process.env.PORT ?? 4610);
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;

const store = new Store();

/** @type {Map<string, { userId: string | null }>} */
const sessions = new Map();

/** @type {Record<string, string>} */
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * @typedef {import("node:http").IncomingMessage} Req
 * @typedef {import("node:http").ServerResponse} Res
 * @typedef {{ sid: string, session: { userId: string | null }, body: any, params: Record<string, string> }} Ctx
 * @typedef {(ctx: Ctx) => unknown | Promise<unknown>} Handler
 */

/** @type {Array<{ method: string, pattern: RegExp, keys: string[], handler: Handler }>} */
const routes = [];

/**
 * @param {string} method
 * @param {string} path  e.g. "/api/cart/items/:productId"
 * @param {Handler} handler
 */
function route(method, path, handler) {
  /** @type {string[]} */
  const keys = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "$",
  );
  routes.push({ method, pattern, keys, handler });
}

// ---------------------------------------------------------------- API

route("GET", "/api/health", () => ({ ok: true, app: "proofwright-shop" }));

route("GET", "/api/products", () => store.listProducts());

route("GET", "/api/recommendations", async () => {
  // Recommendations come from a slower service: 0–1.5 s, differently each time.
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 1500)));
  return store.listProducts().slice(0, 3).map((p) => ({ id: p.id, name: p.name }));
});

route("GET", "/api/cart", ({ sid }) => store.cartView(sid));
route("POST", "/api/cart/items", ({ sid, body }) => store.addItem(sid, String(body.productId ?? ""), body.qty ?? 1));
route("PATCH", "/api/cart/items/:productId", ({ sid, body, params }) =>
  store.setQuantity(sid, params.productId, Number(body.qty)),
);
route("DELETE", "/api/cart/items/:productId", ({ sid, params }) => store.removeItem(sid, params.productId));
route("POST", "/api/cart/coupon", ({ sid, body }) => store.applyCoupon(sid, body.code));
route("DELETE", "/api/cart/coupon", ({ sid }) => store.removeCoupon(sid));

route("POST", "/api/signup", ({ session, body }) => {
  const user = store.signUp(body);
  session.userId = user.id;
  return { status: 201, body: user };
});
route("POST", "/api/login", ({ session, body }) => {
  const user = store.logIn(body.email, body.password);
  session.userId = user.id;
  return user;
});
route("POST", "/api/logout", ({ session }) => {
  session.userId = null;
  return { status: 204 };
});
route("GET", "/api/me", ({ session }) => ({ user: session.userId ? store.user(session.userId) : null }));

route("POST", "/api/orders", ({ sid, session, body }) => {
  const order = store.placeOrder(session.userId, sid, body.shipping ?? {});
  return { status: 201, body: { orderId: order.id } };
});
route("GET", "/api/orders/:id", ({ session, params }) => store.order(session.userId, params.id));

// ---------------------------------------------------------------- plumbing

/** @param {Req} req */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ShopError(413, "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(new ShopError(400, "The request body isn't valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** @param {Req} req */
function sessionFor(req) {
  const match = /(?:^|;\s*)sid=([A-Za-z0-9-]+)/.exec(req.headers.cookie ?? "");
  const known = match && sessions.has(match[1]) ? match[1] : null;
  const sid = known ?? randomUUID();
  if (!known) sessions.set(sid, { userId: null });
  return { sid, session: /** @type {{ userId: string | null }} */ (sessions.get(sid)), isNew: !known };
}

/**
 * @param {Res} res
 * @param {number} status
 * @param {unknown} [body]
 */
function sendJson(res, status, body) {
  if (status === 204 || body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * @param {Req} req
 * @param {Res} res
 * @param {string} pathname
 */
async function handleApi(req, res, pathname) {
  const { sid, session, isNew } = sessionFor(req);
  if (isNew) res.setHeader("set-cookie", `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  const candidates = routes.filter((r) => r.pattern.test(pathname));
  if (candidates.length === 0) return sendJson(res, 404, { error: "Not found" });
  const hit = candidates.find((r) => r.method === req.method);
  if (!hit) return sendJson(res, 405, { error: "Method not allowed" });
  const values = /** @type {RegExpExecArray} */ (hit.pattern.exec(pathname)).slice(1);
  /** @type {Record<string, string>} */
  const params = Object.fromEntries(hit.keys.map((k, i) => [k, decodeURIComponent(values[i])]));
  const body = req.method === "GET" || req.method === "DELETE" ? {} : await readBody(req);
  const result = await hit.handler({ sid, session, body, params });
  if (result && typeof result === "object" && "status" in result && typeof result.status === "number") {
    const r = /** @type {{ status: number, body?: unknown }} */ (result);
    return sendJson(res, r.status, r.body);
  }
  return sendJson(res, 200, result);
}

/**
 * @param {Res} res
 * @param {string} pathname
 */
async function handleStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 404, { error: "Not found" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (pathname.startsWith("/api/")) await handleApi(req, res, pathname);
    else await handleStatic(res, pathname);
  } catch (err) {
    if (err instanceof ShopError) {
      sendJson(res, err.status, err.fields ? { error: err.message, fields: err.fields } : { error: err.message });
      return;
    }
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong on our side" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Proofwright Shop on http://${HOST}:${PORT}`);
});

for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

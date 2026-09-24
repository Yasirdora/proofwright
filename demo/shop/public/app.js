// @ts-check
/**
 * Proofwright Shop — the page. A hash router over a handful of views, built
 * with DOM calls (never innerHTML with data), talking to /api.
 */

export {}; // a module (loaded with type="module"), so top-level await is allowed

const app = /** @type {HTMLElement} */ (document.getElementById("app"));
const flash = /** @type {HTMLElement} */ (document.getElementById("flash"));
const cartCount = /** @type {HTMLElement} */ (document.getElementById("cart-count"));
const accountLinks = /** @type {HTMLElement} */ (document.getElementById("account-links"));

const money = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
/** @param {number} cents */
const eur = (cents) => money.format(cents / 100);

/** @type {{ id: string, name: string, email: string } | null} */
let me = null;

// ---------------------------------------------------------------- helpers

/**
 * Create an element. Children that are strings become text nodes.
 * @param {string} tag
 * @param {Record<string, string | boolean | ((e: Event) => void)>} [attrs]
 * @param {Array<Node | string | null | undefined | false>} [children]
 */
function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<{ status: number, ok: boolean, body: any }>}
 */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text ? JSON.parse(text) : null };
}

/** @param {Array<Node | string | null | undefined | false>} children */
function show(...children) {
  app.replaceChildren(...children.filter((c) => !!c).map((c) => /** @type {Node | string} */ (c)));
}

/** A flash message survives exactly one navigation (e.g. "Welcome, Ada!" after sign-up). */
let keepFlash = false;

/** @param {string} message */
function say(message) {
  flash.textContent = message;
  keepFlash = true;
}

/**
 * Show per-field errors under their inputs, and a summary above the form.
 * @param {HTMLFormElement} form
 * @param {{ error?: string, fields?: Record<string, string> }} body
 */
function showErrors(form, body) {
  for (const old of form.querySelectorAll(".field-error")) old.remove();
  for (const input of form.querySelectorAll("input")) {
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
  }
  const summary = /** @type {HTMLElement} */ (form.querySelector(".error"));
  summary.textContent = body.error ?? "";
  for (const [name, message] of Object.entries(body.fields ?? {})) {
    const input = form.querySelector(`[name="${name}"]`);
    if (!input) continue;
    const id = `${name}-error`;
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", id);
    // After the label, not inside it: inside, the message would become part of the field's name.
    (input.closest("label") ?? input).after(h("span", { class: "field-error", id }, [message]));
  }
}

/**
 * A labelled input for a form.stack.
 * @param {string} label
 * @param {string} name
 * @param {Record<string, string | boolean>} [attrs]
 */
function field(label, name, attrs = {}) {
  return h("label", {}, [label, h("input", { name, id: name, ...attrs })]);
}

/** @param {HTMLFormElement} form */
function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function refreshCart() {
  const res = await api("GET", "/api/cart");
  cartCount.textContent = String(res.body.count);
  return res.body;
}

async function refreshMe() {
  me = (await api("GET", "/api/me")).body.user;
  accountLinks.replaceChildren(
    ...(me
      ? [
          h("span", {}, [`Hi, ${me.name}`]),
          " ",
          h("button", { class: "link-button", type: "button", onclick: logOut }, ["Log out"]),
        ]
      : [h("a", { href: "#/signup" }, ["Sign up"]), " ", h("a", { href: "#/login" }, ["Log in"])]),
  );
}

async function logOut() {
  await api("POST", "/api/logout");
  await refreshMe();
  say("You're logged out.");
  location.hash = "#/";
}

// ---------------------------------------------------------------- views

async function productsView() {
  const products = (await api("GET", "/api/products")).body;
  const recs = h("section", { class: "recs", "aria-label": "Recommended for you", "data-testid": "recommendations" }, [
    h("h2", {}, ["Recommended for you"]),
    h("p", {}, ["Finding things you'll like…"]),
  ]);
  show(
    h("h1", {}, ["Products"]),
    h(
      "ul",
      { class: "products", "aria-label": "Products" },
      products.map((/** @type {any} */ p) =>
        h("li", { class: "product" }, [
          h("h2", {}, [p.name]),
          h("p", { class: "price" }, [
            eur(p.salePriceCents ?? p.priceCents),
            p.salePriceCents ? h("s", {}, [`was ${eur(p.priceCents)}`]) : null,
          ]),
          h("p", { class: "stock" }, [p.stock <= 5 ? `Only ${p.stock} left` : "In stock"]),
          h(
            "button",
            {
              class: "primary",
              type: "button",
              "aria-label": `Add ${p.name} to cart`,
              onclick: async () => {
                const res = await api("POST", "/api/cart/items", { productId: p.id, qty: 1 });
                if (!res.ok) return say(res.body.error);
                cartCount.textContent = String(res.body.count);
                say(`${p.name} added to your cart.`);
              },
            },
            ["Add to cart"],
          ),
        ]),
      ),
    ),
    recs,
  );
  const list = (await api("GET", "/api/recommendations")).body;
  recs.replaceChildren(
    h("h2", {}, ["Recommended for you"]),
    h(
      "ul",
      {},
      list.map((/** @type {any} */ r) => h("li", {}, [r.name])),
    ),
  );
}

async function cartView() {
  const cart = await refreshCart();
  if (cart.lines.length === 0) {
    show(h("h1", {}, ["Your cart"]), h("p", {}, ["Your cart is empty."]), h("a", { href: "#/" }, ["Browse products"]));
    return;
  }
  const couponError = h("p", { class: "error", role: "alert" });
  const couponInput = /** @type {HTMLInputElement} */ (h("input", { id: "coupon", name: "code", autocomplete: "off" }));
  show(
    h("h1", {}, ["Your cart"]),
    h("table", {}, [
      h("thead", {}, [
        h("tr", {}, [
          h("th", { scope: "col" }, ["Product"]),
          h("th", { scope: "col" }, ["Quantity"]),
          h("th", { scope: "col", class: "num" }, ["Price"]),
          h("th", { scope: "col" }, [h("span", { class: "visually-hidden" }, ["Actions"])]),
        ]),
      ]),
      h(
        "tbody",
        {},
        cart.lines.map((/** @type {any} */ l) =>
          h("tr", {}, [
            h("td", {}, [l.name]),
            h("td", {}, [
              h("input", {
                type: "number",
                min: "1",
                max: "99",
                value: String(l.qty),
                "aria-label": `Quantity for ${l.name}`,
                onchange: async (/** @type {Event} */ e) => {
                  const qty = Number(/** @type {HTMLInputElement} */ (e.target).value);
                  const res = await api("PATCH", `/api/cart/items/${l.productId}`, { qty });
                  if (!res.ok) say(res.body.error);
                  await cartView();
                },
              }),
            ]),
            h("td", { class: "num" }, [eur(l.lineCents)]),
            h("td", {}, [
              h(
                "button",
                {
                  type: "button",
                  class: "link-button",
                  "aria-label": `Remove ${l.name}`,
                  onclick: async () => {
                    await api("DELETE", `/api/cart/items/${l.productId}`);
                    await cartView();
                  },
                },
                ["Remove"],
              ),
            ]),
          ]),
        ),
      ),
    ]),
    h(
      "form",
      {
        class: "coupon",
        "aria-label": "Coupon",
        novalidate: true,
        onsubmit: (/** @type {Event} */ e) => e.preventDefault(),
      },
      [
        h("label", { for: "coupon" }, ["Coupon code", couponInput]),
        h(
          "button",
          {
            type: "button",
            onclick: async () => {
              const res = await api("POST", "/api/cart/coupon", { code: couponInput.value });
              if (!res.ok) {
                couponError.textContent = res.body.error;
                return;
              }
              await cartView();
              say(`${res.body.coupon} applied.`);
            },
          },
          ["Apply"],
        ),
      ],
    ),
    couponError,
    h("section", { class: "summary", "aria-label": "Order summary" }, [
      h("dl", {}, [
        h("dt", {}, ["Subtotal"]),
        h("dd", { "data-testid": "subtotal" }, [eur(cart.subtotalCents)]),
        cart.coupon ? h("dt", {}, [`Discount (${cart.coupon})`]) : null,
        cart.coupon ? h("dd", { "data-testid": "discount" }, [`−${eur(cart.discountCents)}`]) : null,
        h("dt", {}, ["Total"]),
        h("dd", { "data-testid": "total" }, [eur(cart.totalCents)]),
      ]),
      h("a", { href: "#/checkout", class: "primary" }, ["Go to checkout"]),
    ]),
  );
}

async function signupView() {
  const form = /** @type {HTMLFormElement} */ (
    h("form", { class: "stack", "aria-label": "Sign up", novalidate: true }, [
      h("p", { class: "error", role: "alert" }),
      field("Full name", "name", { autocomplete: "name" }),
      field("Email", "email", { type: "email", autocomplete: "email" }),
      field("Password", "password", { type: "password", autocomplete: "new-password" }),
      field("Confirm password", "confirmPassword", { type: "password", autocomplete: "new-password" }),
      field("Date of birth", "birthDate", { type: "date" }),
      h("button", { class: "primary", type: "submit" }, ["Create account"]),
    ])
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await api("POST", "/api/signup", formData(form));
    if (!res.ok) return showErrors(form, res.body);
    await refreshMe();
    say(`Welcome, ${res.body.name}!`);
    location.hash = "#/";
  });
  show(h("h1", {}, ["Create your account"]), form);
}

/** @param {URLSearchParams} query */
async function loginView(query) {
  const form = /** @type {HTMLFormElement} */ (
    h("form", { class: "stack", "aria-label": "Log in", novalidate: true }, [
      h("p", { class: "error", role: "alert" }),
      field("Email", "email", { type: "email", autocomplete: "email" }),
      field("Password", "password", { type: "password", autocomplete: "current-password" }),
      h("button", { class: "primary", type: "submit" }, ["Log in"]),
    ])
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await api("POST", "/api/login", formData(form));
    if (!res.ok) return showErrors(form, res.body);
    await refreshMe();
    say(`Welcome back, ${res.body.name}!`);
    location.hash = query.get("next") === "checkout" ? "#/checkout" : "#/";
  });
  show(h("h1", {}, ["Log in"]), form);
}

async function checkoutView() {
  if (!me) {
    show(
      h("h1", {}, ["Checkout"]),
      h("p", {}, ["Log in to check out. ", h("a", { href: "#/login?next=checkout" }, ["Log in"])]),
    );
    return;
  }
  const cart = await refreshCart();
  if (cart.lines.length === 0) {
    show(h("h1", {}, ["Checkout"]), h("p", {}, ["Your cart is empty."]), h("a", { href: "#/" }, ["Browse products"]));
    return;
  }
  const form = /** @type {HTMLFormElement} */ (
    h("form", { class: "stack", "aria-label": "Shipping", novalidate: true }, [
      h("p", { class: "error", role: "alert" }),
      field("Full name", "fullName", { autocomplete: "name", value: me.name }),
      field("Address", "address", { autocomplete: "street-address" }),
      field("Postal code", "postalCode", { autocomplete: "postal-code" }),
      field("Phone (optional)", "phone", { type: "tel", autocomplete: "tel" }),
      h("p", {}, ["Total to pay: ", h("strong", { "data-testid": "checkout-total" }, [eur(cart.totalCents)])]),
      h("button", { class: "primary", type: "submit" }, ["Place order"]),
    ])
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await api("POST", "/api/orders", { shipping: formData(form) });
    if (res.status === 400) return showErrors(form, res.body);
    if (res.status === 401) {
      location.hash = "#/login?next=checkout";
      return;
    }
    await refreshCart();
    location.hash = res.body?.orderId ? `#/order/${res.body.orderId}` : "#/thank-you";
  });
  show(h("h1", {}, ["Checkout"]), form);
}

/** @param {string} id */
async function orderView(id) {
  const res = await api("GET", `/api/orders/${encodeURIComponent(id)}`);
  if (!res.ok) {
    show(h("h1", {}, ["Order not found"]), h("p", {}, [res.body.error]));
    return;
  }
  const o = res.body;
  show(
    h("h1", {}, [`Thank you, ${o.shipping.fullName}!`]),
    h("p", {}, [`Order ${o.id} is placed.`]),
    h("p", {}, ["Total paid: ", h("strong", { "data-testid": "order-total" }, [eur(o.totalCents)])]),
  );
}

function thankYouView() {
  show(h("h1", {}, ["Thank you!"]), h("p", {}, ["Your order is placed."]));
}

// ---------------------------------------------------------------- router

async function render() {
  const [path, rawQuery] = (location.hash.slice(1) || "/").split("?");
  const query = new URLSearchParams(rawQuery ?? "");
  const order = /^\/order\/(.+)$/.exec(path);
  if (path === "/" || path === "") await productsView();
  else if (path === "/cart") await cartView();
  else if (path === "/signup") await signupView();
  else if (path === "/login") await loginView(query);
  else if (path === "/checkout") await checkoutView();
  else if (order) await orderView(decodeURIComponent(order[1]));
  else if (path === "/thank-you") thankYouView();
  else show(h("h1", {}, ["Page not found"]), h("a", { href: "#/" }, ["Back to products"]));
}

window.addEventListener("hashchange", () => {
  if (!keepFlash) flash.textContent = "";
  keepFlash = false;
  void render();
});

await Promise.all([refreshMe(), refreshCart()]);
await render();

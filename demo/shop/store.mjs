// @ts-check
/**
 * Proofwright Shop — the in-memory store behind the demo API.
 *
 * Everything lives in memory and resets when the server restarts. The rules
 * the shop promises are written down in demo/README.md; the HTTP layer is
 * server.mjs, and the page is public/.
 */
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * @typedef {{ id: string, name: string, priceCents: number, salePriceCents?: number, stock: number }} Product
 * @typedef {{ id: string, name: string, email: string, birthDate: string, passwordHash: string, salt: string }} User
 * @typedef {{ items: Map<string, number>, coupons: string[] }} Cart
 * @typedef {{ id: string, userId: string, lines: CartLine[], subtotalCents: number, discountCents: number, totalCents: number,
 *   shipping: Shipping, placedAt: string }} Order
 * @typedef {{ fullName: string, address: string, postalCode: string, phone: string }} Shipping
 * @typedef {{ productId: string, name: string, unitCents: number, qty: number, lineCents: number }} CartLine
 * @typedef {{ kind: "percent", percent: number, expired?: boolean, minSubtotalCents?: number }
 *   | { kind: "amount", amountCents: number, expired?: boolean, minSubtotalCents?: number }} Coupon
 */

/** A failure the API reports to the client: an HTTP status and a message (or per-field messages). */
export class ShopError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {Record<string, string>} [fields]
   */
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export const MAX_QTY = 99;

/** @type {Record<string, Coupon>} */
const COUPONS = {
  SAVE10: { kind: "percent", percent: 10 },
  WELCOME5: { kind: "amount", amountCents: 500, minSubtotalCents: 2000 },
  SPRING24: { kind: "percent", percent: 15, expired: true },
};

const money = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
/** @param {number} cents */
export const formatCents = (cents) => money.format(cents / 100);

export class Store {
  constructor() {
    /** @type {Product[]} */
    const seed = JSON.parse(readFileSync(new URL("./data/products.json", import.meta.url), "utf8"));
    /** @type {Map<string, Product>} */
    this.products = new Map(seed.map((p) => [p.id, { ...p }]));
    /** @type {Map<string, User>} */
    this.users = new Map();
    /** @type {Map<string, Cart>} */
    this.carts = new Map();
    /** @type {Map<string, Order>} */
    this.orders = new Map();
    this.nextOrder = 1001;
  }

  // ---------------------------------------------------------------- products

  listProducts() {
    return [...this.products.values()].map((p) => ({ ...p }));
  }

  /** @param {string} id */
  product(id) {
    const p = this.products.get(id);
    if (!p) throw new ShopError(404, "That product doesn't exist");
    return p;
  }

  /** @param {Product} p */
  static unitCents(p) {
    return p.salePriceCents ?? p.priceCents;
  }

  // ---------------------------------------------------------------- cart

  /** @param {string} cartId */
  cart(cartId) {
    let cart = this.carts.get(cartId);
    if (!cart) {
      cart = { items: new Map(), coupons: [] };
      this.carts.set(cartId, cart);
    }
    return cart;
  }

  /**
   * @param {string} cartId
   * @param {string} productId
   * @param {number} qty
   */
  addItem(cartId, productId, qty = 1) {
    this.product(productId);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      throw new ShopError(400, `Choose a quantity from 1 to ${MAX_QTY}`);
    }
    const cart = this.cart(cartId);
    const next = (cart.items.get(productId) ?? 0) + qty;
    cart.items.set(productId, Math.min(next, MAX_QTY));
    return this.cartView(cartId);
  }

  /**
   * @param {string} cartId
   * @param {string} productId
   * @param {number} qty
   */
  setQuantity(cartId, productId, qty) {
    const cart = this.cart(cartId);
    if (!cart.items.has(productId)) throw new ShopError(404, "That product isn't in your cart");
    if (!Number.isInteger(qty) || qty > MAX_QTY) {
      throw new ShopError(400, `Choose a quantity from 1 to ${MAX_QTY}`);
    }
    if (qty === 0) cart.items.delete(productId);
    else cart.items.set(productId, qty);
    return this.cartView(cartId);
  }

  /**
   * @param {string} cartId
   * @param {string} productId
   */
  removeItem(cartId, productId) {
    this.cart(cartId).items.delete(productId);
    return this.cartView(cartId);
  }

  /**
   * @param {string} cartId
   * @param {string} rawCode
   */
  applyCoupon(cartId, rawCode) {
    const code = String(rawCode ?? "").trim().toUpperCase();
    const coupon = COUPONS[code];
    if (!coupon) throw new ShopError(400, "This coupon code isn't valid");
    if (coupon.expired) throw new ShopError(400, "This coupon has expired");
    const cart = this.cart(cartId);
    if (cart.items.size === 0) throw new ShopError(400, "Add something to your cart first");
    const subtotal = this.subtotalCents(cart);
    if (coupon.minSubtotalCents !== undefined && !(subtotal > coupon.minSubtotalCents)) {
      throw new ShopError(400, `Spend at least ${formatCents(coupon.minSubtotalCents)} to use this coupon`);
    }
    // One coupon per order: a different code replaces the one already applied.
    if (cart.coupons.some((c) => c !== code)) cart.coupons = [];
    cart.coupons.push(code);
    return this.cartView(cartId);
  }

  /** @param {string} cartId */
  removeCoupon(cartId) {
    this.cart(cartId).coupons = [];
    return this.cartView(cartId);
  }

  /** @param {Cart} cart */
  lines(cart) {
    /** @type {CartLine[]} */
    const out = [];
    for (const [productId, qty] of cart.items) {
      const p = this.product(productId);
      const unitCents = Store.unitCents(p);
      out.push({ productId, name: p.name, unitCents, qty, lineCents: unitCents * qty });
    }
    return out;
  }

  /** @param {Cart} cart */
  subtotalCents(cart) {
    return this.lines(cart).reduce((sum, l) => sum + l.lineCents, 0);
  }

  /** @param {Cart} cart */
  discountCents(cart) {
    const subtotal = this.subtotalCents(cart);
    let discount = 0;
    for (const code of cart.coupons) {
      const coupon = COUPONS[code];
      discount += coupon.kind === "percent" ? Math.floor((subtotal * coupon.percent) / 100) : coupon.amountCents;
    }
    return Math.min(discount, Math.max(subtotal, 0));
  }

  /** @param {string} cartId */
  cartView(cartId) {
    const cart = this.cart(cartId);
    const lines = this.lines(cart);
    const subtotalCents = this.subtotalCents(cart);
    const discountCents = this.discountCents(cart);
    return {
      lines,
      count: lines.reduce((n, l) => n + l.qty, 0),
      coupon: cart.coupons[0] ?? null,
      subtotalCents,
      discountCents,
      totalCents: Math.max(0, subtotalCents - discountCents),
    };
  }

  // ---------------------------------------------------------------- accounts

  /**
   * @param {{ name?: unknown, email?: unknown, password?: unknown, confirmPassword?: unknown, birthDate?: unknown }} input
   * @param {Date} today
   */
  signUp(input, today = new Date()) {
    const name = String(input.name ?? "").trim();
    const email = String(input.email ?? "").trim().toLowerCase();
    const password = String(input.password ?? "");
    const confirm = String(input.confirmPassword ?? "");
    const birthDate = String(input.birthDate ?? "");
    /** @type {Record<string, string>} */
    const fields = {};
    if (!name) fields.name = "Enter your name";
    else if ([...name].length > 60) fields.name = "Use 60 characters or fewer";
    if (!email) fields.email = "Enter your email address";
    else if (!/^[^\s@]+@[^\s@]+$/.test(email)) fields.email = "Enter a valid email address";
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      fields.password = "Use at least 8 characters, with a letter and a number";
    }
    if (confirm !== password) fields.confirmPassword = "The passwords don't match";
    const age = ageOn(birthDate, today);
    if (age === null) fields.birthDate = "Enter your date of birth";
    else if (age < 18) fields.birthDate = "You must be 18 or older";
    if (Object.keys(fields).length > 0) throw new ShopError(400, "Check the highlighted fields", fields);
    if ([...this.users.values()].some((u) => u.email === email)) {
      throw new ShopError(409, "An account with this email already exists", {
        email: "An account with this email already exists",
      });
    }
    const salt = randomBytes(16).toString("hex");
    /** @type {User} */
    const user = { id: randomUUID(), name, email, birthDate, salt, passwordHash: hash(password, salt) };
    this.users.set(user.id, user);
    return publicUser(user);
  }

  /**
   * @param {unknown} rawEmail
   * @param {unknown} rawPassword
   */
  logIn(rawEmail, rawPassword) {
    const email = String(rawEmail ?? "").trim().toLowerCase();
    const password = String(rawPassword ?? "");
    const user = [...this.users.values()].find((u) => u.email === email);
    const ok =
      user !== undefined &&
      timingSafeEqual(Buffer.from(hash(password, user.salt), "hex"), Buffer.from(user.passwordHash, "hex"));
    if (!ok) throw new ShopError(401, "Email or password is incorrect");
    return publicUser(user);
  }

  /** @param {string} id */
  user(id) {
    const u = this.users.get(id);
    return u ? publicUser(u) : null;
  }

  // ---------------------------------------------------------------- orders

  /**
   * @param {string | null} userId
   * @param {string} cartId
   * @param {Partial<Record<keyof Shipping, unknown>>} input
   */
  placeOrder(userId, cartId, input) {
    if (!userId) throw new ShopError(401, "Log in to place an order");
    const cart = this.cart(cartId);
    if (cart.items.size === 0) throw new ShopError(400, "Your cart is empty");
    const shipping = {
      fullName: String(input.fullName ?? "").trim(),
      address: String(input.address ?? "").trim(),
      postalCode: String(input.postalCode ?? "").trim(),
      phone: String(input.phone ?? "").trim(),
    };
    /** @type {Record<string, string>} */
    const fields = {};
    if (!shipping.fullName) fields.fullName = "Enter the recipient's name";
    else if ([...shipping.fullName].length > 60) fields.fullName = "Use 60 characters or fewer";
    if (!shipping.address) fields.address = "Enter the delivery address";
    if (!/^[A-Za-z0-9][A-Za-z0-9 -]{1,8}[A-Za-z0-9]$/.test(shipping.postalCode)) {
      fields.postalCode = "Enter a valid postal code";
    }
    if (shipping.phone && !/^\+?[0-9 ()-]{6,20}$/.test(shipping.phone)) fields.phone = "Enter a valid phone number";
    if (Object.keys(fields).length > 0) throw new ShopError(400, "Check the highlighted fields", fields);

    const lines = this.lines(cart);
    for (const line of lines) {
      const p = this.product(line.productId);
      if (line.qty > p.stock) throw new ShopError(409, `Only ${p.stock} left of ${p.name}`);
    }
    for (const line of lines) this.product(line.productId).stock -= line.qty;

    const view = this.cartView(cartId);
    /** @type {Order} */
    const order = {
      id: `PW-${this.nextOrder++}`,
      userId,
      lines,
      subtotalCents: view.subtotalCents,
      discountCents: view.discountCents,
      totalCents: view.totalCents,
      shipping: { ...shipping, fullName: clip(shipping.fullName) },
      placedAt: new Date().toISOString(),
    };
    this.orders.set(order.id, order);
    this.carts.delete(cartId);
    return order;
  }

  /**
   * @param {string | null} userId
   * @param {string} id
   */
  order(userId, id) {
    const order = this.orders.get(id);
    if (!order || order.userId !== userId) throw new ShopError(404, "That order doesn't exist");
    return order;
  }
}

/** The label printer takes 24 bytes per name line. */
const LABEL_BYTES = 24;

/** @param {string} name */
function clip(name) {
  return Buffer.from(name, "utf8").subarray(0, LABEL_BYTES).toString("utf8");
}

/**
 * @param {string} password
 * @param {string} salt
 */
function hash(password, salt) {
  return scryptSync(password, salt, 32).toString("hex");
}

/** @param {User} u */
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email };
}

/**
 * Whole years between an ISO date (YYYY-MM-DD) and today, in UTC; null when
 * the date is missing, malformed, or in the future.
 *
 * @param {string} iso
 * @param {Date} today
 */
function ageOn(iso, today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const born = new Date(Date.UTC(y, mo - 1, d));
  if (born.getUTCFullYear() !== y || born.getUTCMonth() !== mo - 1 || born.getUTCDate() !== d) return null;
  if (born.getTime() > today.getTime()) return null;
  let age = today.getUTCFullYear() - y;
  const beforeBirthday =
    today.getUTCMonth() < mo - 1 || (today.getUTCMonth() === mo - 1 && today.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

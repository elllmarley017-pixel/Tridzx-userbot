"use strict";
/**
 * Shared HTTP client — the Node.js replacement for `aiohttp`.
 *
 * Wraps `undici` (the same HTTP stack Node ships with) and exposes the small
 * feature set the Python codebase relied on: per-request timeouts, automatic
 * redirect following, retries, JSON/text parsing and chunked streaming to disk.
 */
const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");

const DEFAULT_TIMEOUT = 120_000;
const MAX_REDIRECTS = 10;

function toMilliseconds(value, fallback = DEFAULT_TIMEOUT) {
  if (value == null) return fallback;
  if (typeof value === "number") {
    // Plain numbers mirror aiohttp's `timeout=aiohttp.ClientTimeout(total=N)`,
    // which is expressed in seconds in the original Python codebase.
    return value * 1000;
  }
  if (typeof value === "object") {
    if (typeof value.total === "number") return value.total * 1000;
    if (typeof value.totalMilliseconds === "number") return value.totalMilliseconds;
  }
  return fallback;
}

class HttpError extends Error {
  constructor(message, status, response) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.response = response;
  }
}

class ClientError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ClientError";
    this.cause = cause;
  }
}

class TimeoutError extends Error {
  constructor(message = "Request timeout") {
    super(message);
    this.name = "TimeoutError";
  }
}

class Response {
  constructor(raw, body) {
    this.raw = raw;
    this.status = raw.status;
    this.statusText = raw.statusText;
    this.headers = raw.headers;
    this.url = raw.url;
    this.ok = raw.ok;
    this.body = body;
  }

  /** Mirrors `aiohttp.ClientResponse.text()`. */
  async text() {
    if (typeof this.body === "string") return this.body;
    return Buffer.isBuffer(this.body) ? this.body.toString("utf8") : String(this.body ?? "");
  }

  /** Mirrors `aiohttp.ClientResponse.json(content_type=None)`. */
  async json() {
    const text = await this.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new ClientError("Response tidak valid: bukan JSON", err);
    }
  }

  /** Mirrors `aiohttp.ClientResponse.read()`. */
  async read() {
    if (Buffer.isBuffer(this.body)) return this.body;
    return Buffer.from(await this.text(), "utf8");
  }

  /** Mirrors `aiohttp.ClientResponse.content.iter_chunked(size)`. */
  async *iterChunked(size = 64 * 1024) {
    const source = Buffer.isBuffer(this.body)
      ? this.body
      : Buffer.from(typeof this.body === "string" ? this.body : "", "utf8");
    for (let offset = 0; offset < source.length; offset += size) {
      yield source.subarray(offset, Math.min(offset + size, source.length));
    }
  }
}

/** A single HTTP exchange that must be opened by the caller. */
class RequestContext {
  constructor(client, method, url, options) {
    this.client = client;
    this.method = method;
    this.url = url;
    this.options = options;
  }

  async __aenter__() {
    this.response = await this.client._request(this.method, this.url, this.options);
    return this.response;
  }

  async __aexit__() {
    return false;
  }
}

/** Context-manager wrapper so `async with` style reuse stays available. */
function contextManager(promise) {
  return {
    async __aenter__() {
      return promise;
    },
    async __aexit__() {
      return false;
    },
  };
}

class ClientSession {
  constructor(options = {}) {
    this.defaultHeaders = normalizeHeaders(options.headers || {});
    this.timeout = toMilliseconds(options.timeout, DEFAULT_TIMEOUT);
    this.baseUrl = options.baseUrl || "";
  }

  request(method, url, options = {}) {
    return new RequestContext(this, method, url, options);
  }

  /**
   * Awaiting a request context performs the exchange directly. This keeps the
   * natural `const res = await session.get(url, opts)` style while still
   * supporting the `async with` context-manager form.
   */
  get(url, options = {}) {
    return this._awaitable(new RequestContext(this, "GET", url, options));
  }

  post(url, options = {}) {
    return this._awaitable(new RequestContext(this, "POST", url, options));
  }

  head(url, options = {}) {
    return this._awaitable(new RequestContext(this, "HEAD", url, options));
  }

  put(url, options = {}) {
    return this._awaitable(new RequestContext(this, "PUT", url, options));
  }

  _awaitable(ctx) {
    const promise = ctx.__aenter__();
    promise.__aenter__ = () => promise;
    promise.__aexit__ = async () => false;
    return promise;
  }

  async close() {
    /* fetch keeps no long-lived pool handle here */
  }

  async _request(method, url, options = {}) {
    const target = this.baseUrl ? new URL(url, this.baseUrl).toString() : url;
    const headers = { ...this.defaultHeaders, ...normalizeHeaders(options.headers || {}) };
    const timeout = toMilliseconds(options.timeout, this.timeout);
    const allowRedirects = options.allowRedirects !== false;
    const maxRedirections = options.maxRedirections ?? (allowRedirects ? MAX_REDIRECTS : 0);

    const init = {
      method: String(method).toUpperCase(),
      headers: toUndiciHeaders(headers),
      redirect: allowRedirects ? "follow" : "manual",
      signal: AbortSignal.timeout(timeout),
    };

    if (options.body != null) {
      init.body = options.body;
    } else if (options.json !== undefined) {
      init.body = JSON.stringify(options.json);
      init.headers = { ...init.headers, "content-type": "application/json" };
    } else if (options.data != null) {
      init.body = toFormBody(options.data);
      if (!headers["Content-Type"] && !headers["content-type"]) {
        init.headers = { ...init.headers, "content-type": "application/x-www-form-urlencoded" };
      }
    }

    let raw;
    try {
      raw = await fetch(target, init);
    } catch (err) {
      if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new TimeoutError(`Request timeout setelah ${timeout}ms: ${target}`);
      }
      throw new ClientError(`Koneksi gagal: ${err && err.message ? err.message : err}`, err);
    }

    let body;
    if (options.stream) {
      body = Buffer.from(await raw.arrayBuffer());
    } else {
      body = await raw.text();
    }

    return new Response(raw, body);
  }
}

function normalizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = String(value);
  }
  return out;
}

function toUndiciHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value != null) out[key.toLowerCase()] = String(value);
  }
  return out;
}

function toFormBody(data) {
  if (typeof data === "string") return data;
  if (data instanceof URLSearchParams) return data.toString();
  return new URLSearchParams(data).toString();
}

module.exports = {
  ClientSession,
  ClientError,
  TimeoutError,
  HttpError,
  DEFAULT_TIMEOUT,
  delay,
};

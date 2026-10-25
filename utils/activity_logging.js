"use strict";
/**
 * Centralized, failure-safe command activity logging.
 *
 * Node.js port of `utils/activity_logging.py`. Replaces:
 *   - `contextvars`        -> `AsyncLocalStorage`
 *   - `logging`            -> `utils/logging.js`
 *   - `zoneinfo`           -> `Intl.DateTimeFormat` with a fixed-offset fallback
 *   - handler wrapping     -> event-handler middleware installed on the client
 */
const { AsyncLocalStorage } = require("node:async_hooks");

const { LOG_DIR, LOG_FILE, LOG_TIMEZONE } = require("../config");
const { createLogger, createFileHandler, createStreamHandler } = require("./logging");

const STATUS = new Set(["PENDING", "SUCCESS", "FAILED"]);

const SECRET_RE =
  /(api[_-]?key|token|password|passwd|otp|authorization|secret)(\s*[:=]\s*|\s+)([^\s,;]+)/gi;
const BEARER_RE = /bearer\s+[A-Za-z0-9._~+/=-]+/gi;

const TIMEZONE_OFFSETS = {
  "Asia/Jakarta": 7,
  "Asia/Makassar": 8,
  "Asia/Jayapura": 9,
  UTC: 0,
};
const TIMEZONE_ABBR = {
  "Asia/Jakarta": "WIB",
  "Asia/Makassar": "WITA",
  "Asia/Jayapura": "WIT",
  UTC: "UTC",
};

const storage = new AsyncLocalStorage();
const activityLogger = createLogger("telegram_userbot.activity", { level: "INFO" });
let configured = false;

/**
 * Resolve the configured timezone. Uses the real IANA data when available and
 * falls back to the fixed offsets the Python code shipped for Termux installs
 * that omit the tz database.
 */
function timezone() {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: LOG_TIMEZONE }).format(new Date());
    return { name: LOG_TIMEZONE, offsetHours: null };
  } catch {
    const offsetHours = TIMEZONE_OFFSETS[LOG_TIMEZONE] ?? 0;
    const name = LOG_TIMEZONE in TIMEZONE_OFFSETS ? LOG_TIMEZONE : "UTC";
    return { name, offsetHours };
  }
}

function configureActivityLogging() {
  if (configured) return;
  try {
    const fileHandler = createFileHandler(LOG_FILE, { maxBytes: 5 * 1024 * 1024, backupCount: 3 });
    activityLogger.addHandler(fileHandler);
    activityLogger.addHandler(createStreamHandler(process.stderr));
    activityLogger.level = "INFO";
    activityLogger.propagate = false;
    activityLogger.enabled = true;
    configured = true;
  } catch {
    configured = false;
  }
}

function sanitize(value) {
  let text = String(value == null || value === "" ? "-" : value)
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .trim();
  text = text.replace(SECRET_RE, (_match, key, sep) => `${key}${sep}[REDACTED]`);
  text = text.replace(BEARER_RE, "Bearer [REDACTED]");
  return text.slice(0, 1500) || "-";
}

function formatTimestamp() {
  const { name, offsetHours } = timezone();
  const now = offsetHours == null ? new Date() : new Date(Date.now() + offsetHours * 3600 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: offsetHours == null ? name : "UTC",
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${name}`;
}

function write(activity, status, error = "-") {
  try {
    configureActivityLogging();
    if (!configured || !STATUS.has(status)) return;
    const level = status === "FAILED" ? "error" : "info";
    const message = [
      `USER    : ${sanitize(activity.user)}`,
      `FITUR   : ${sanitize(activity.feature)}`,
      `PROSES  : ${status}`,
      `ERROR   : ${sanitize(error)}`,
      `WAKTU   : ${formatTimestamp()}`,
    ].join("\n");
    activityLogger[level](message);
  } catch {
    /* never throw */
  }
}

async function userLabel(event) {
  const senderId = event?.senderId ?? event?.message?.senderId ?? "Unknown";
  try {
    const sender = await event.getSender();
    const username = sender?.username;
    if (username) return `@${username}`;
    const name = [sender?.firstName, sender?.lastName].filter(Boolean).join(" ");
    return name ? `${name} (${senderId})` : String(senderId);
  } catch {
    return String(senderId);
  }
}

function eventText(event) {
  const message = event?.message || event;
  return (
    message?.rawText ??
    message?.text ??
    event?.rawText ??
    event?.text ??
    ""
  );
}

function feature(event) {
  const text = String(eventText(event)).trim();
  const command = text ? text.split(/\s+/, 1)[0] : "unknown";
  return command.startsWith(".") ? command : `.${command}`;
}

/** Mark the current activity as failed so middleware will not report SUCCESS. */
function markActivityFailed(error) {
  const activity = storage.getStore();
  if (activity) {
    activity.failed = true;
    activity.error = sanitize(error);
  }
}

/**
 * Wrap every subsequently registered handler in one logging middleware.
 * Mirrors the monkey-patched `install_command_logging` from the Python code.
 */
function installCommandLogging(client) {
  if (client.__centralCommandLoggingInstalled) return;
  configureActivityLogging();

  const originalAddEventHandler = client.addEventHandler.bind(client);
  client.addEventHandler = function addEventHandler(callback, event) {
    if (callback.__activityLogged) {
      return originalAddEventHandler(callback, event);
    }
    const loggedCallback = async (update) => {
      const activity = {
        feature: feature(update),
        user: await userLabel(update),
        failed: false,
        error: "-",
      };
      return storage.run(activity, async () => {
        write(activity, "PENDING");
        try {
          const result = await callback(update);
          if (activity.failed) {
            write(activity, "FAILED", activity.error);
          } else {
            write(activity, "SUCCESS");
          }
          return result;
        } catch (err) {
          activity.failed = true;
          activity.error = sanitize(err);
          write(activity, "FAILED", activity.error);
          throw err;
        }
      });
    };
    loggedCallback.__activityLogged = true;
    return originalAddEventHandler(loggedCallback, event);
  };
  client.__centralCommandLoggingInstalled = true;
}

module.exports = {
  Activity: Object,
  installCommandLogging,
  markActivityFailed,
  configureActivityLogging,
  sanitize,
  timezone,
  formatTimestamp,
  LOG_DIR,
  LOG_FILE,
  LOG_TIMEZONE,
};

"use strict";
/**
 * Native-module bootstrap for Termux/Android.
 *
 * Android's SELinux policy blocks `dlopen()` of shared objects that live on
 * shared storage (`/sdcard`, `media_rw` context). Native Node addons such as
 * `@resvg/resvg-js` therefore fail to load from a project kept on `/sdcard`,
 * even though pure-JS packages work fine there.
 *
 * Workaround: install `node_modules` into Termux-internal storage
 * (`$HOME/telegram-userbot-node_modules/node_modules`) and prepend that
 * directory to Node's module resolution here, before any native dependency is
 * required.
 *
 * This file must be required FIRST — before `telegram`, `@resvg/resvg-js`,
 * or any other package that ships a `.node` addon.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const CANDIDATES = [
  process.env.USERBOT_NODE_MODULES,
  path.join(os.homedir(), "telegram-userbot-node_modules", "node_modules"),
  path.join("/data/data/com.termux/files/home", "telegram-userbot-node_modules", "node_modules"),
];

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** `/sdcard` and friends use the media_rw SELinux context (no dlopen). */
function isOnSharedStorage(target) {
  return /^\/(sdcard|storage\/emulated|mnt\/sdcard)/.test(target);
}

let nodeModulesPath = null;
for (const candidate of CANDIDATES) {
  if (candidate && isDirectory(candidate)) {
    nodeModulesPath = candidate;
    break;
  }
}

if (nodeModulesPath) {
  // 1. Global fallback path used by every require() in this process.
  const existing = (process.env.NODE_PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  if (!existing.includes(nodeModulesPath)) {
    process.env.NODE_PATH = [nodeModulesPath, ...existing].join(path.delimiter);
    Module._initPaths();
  }

  // 2. Also inject into the resolver so modules loaded from arbitrary
  //    directories (and nested native sub-requires) can find it.
  const resolveFilename = Module._resolveFilename;
  const nodeModulesName = "node_modules";
  if (!Module.__userbotPatched) {
    Module._resolveFilename = function patchedResolveFilename(request, parent, ...rest) {
      try {
        return resolveFilename.call(this, request, parent, ...rest);
      } catch (err) {
        if (err && (err.code === "MODULE_NOT_FOUND" || /Cannot find module/.test(err.message || ""))) {
          // Only retry for bare specifiers (not relative/absolute paths).
          if (!request.startsWith(".") && !path.isAbsolute(request)) {
            try {
              const candidate = path.join(nodeModulesPath, request);
              return resolveFilename.call(this, candidate, parent, ...rest);
            } catch {
              /* fall through to original error */
            }
          }
        }
        throw err;
      }
    };
    Module.__userbotPatched = true;
  }

  // Keep nested `require('node_modules/...')`-style paths working too.
  void nodeModulesName;
}

module.exports = { nodeModulesPath, isOnSharedStorage };

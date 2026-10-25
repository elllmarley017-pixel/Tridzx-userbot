"use strict";
/** Temp-file lifecycle helpers — Node.js port of `utils/cleanup.py`. */
const fs = require("node:fs");
const path = require("node:path");

const { TEMP_DIR } = require("../config");

function ensureTempDir() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function cleanupFile(...paths) {
  for (const filePath of paths) {
    if (!filePath) continue;
    try {
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Remove all entries in the temp directory. */
function cleanupTempDir() {
  let entries = [];
  try {
    entries = fs.readdirSync(TEMP_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    cleanupFile(path.join(TEMP_DIR, entry));
  }
}

module.exports = { ensureTempDir, cleanupFile, cleanupTempDir };

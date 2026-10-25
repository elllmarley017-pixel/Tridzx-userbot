"use strict";
/**
 * TGS (Telegram animated sticker) → GIF conversion.
 *
 * A `.tgs` file is a gzip-compressed Lottie JSON document. There is no native
 * Node.js Lottie rasterizer, so the pipeline is:
 *
 *   1. gunzip the `.tgs` payload                      (node:zlib)
 *   2. render every frame to SVG with lottie-web      (jsdom + SVG renderer)
 *   3. rasterize each SVG frame to PNG                (@resvg/resvg-js)
 *   4. encode the PNG sequence into an animated GIF   (ffmpeg)
 *
 * lottie-web needs a DOM; jsdom supplies one. jsdom's `<canvas>` has no 2D
 * backend, so lottie-web's internal feature probe is satisfied with a no-op
 * proxy context — the SVG renderer never actually paints to it.
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { Resvg } = require("@resvg/resvg-js");
const { TEMP_DIR } = require("../config");
const { ensureTempDir } = require("../utils/cleanup");
const { runProcess } = require("../utils/process");

const TGS_TIMEOUT_MS = 120 * 1000;
const MAX_FRAMES = 300;
const DEFAULT_SIZE = 512;
const DEFAULT_FPS = 25;

// --------------------------------------------------------------------------
// Lottie runtime (lazy singleton — jsdom boot is comparatively expensive)
// --------------------------------------------------------------------------

let _lottie = null;
let _dom = null;

function noopContext() {
  const target = {};
  return new Proxy(target, {
    get(store, prop) {
      if (prop === "createLinearGradient" || prop === "createRadialGradient") {
        return () => ({ addColorStop() {} });
      }
      if (prop === "createPattern") return () => ({});
      if (prop === "measureText") return () => ({ width: 0 });
      if (prop === "getImageData" || prop === "createImageData") {
        return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      }
      if (prop === "isPointInPath") return () => false;
      if (prop in store) return store[prop];
      return () => {};
    },
    set(store, prop, value) {
      store[prop] = value;
      return true;
    },
  });
}

function loadLottie() {
  if (_lottie) return _lottie;

  const { JSDOM } = require("jsdom");
  _dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { pretendToBeVisual: true });

  const { window } = _dom;
  global.window = window;
  global.document = window.document;
  try {
    Object.defineProperty(global, "navigator", { value: window.navigator, configurable: true, writable: true });
  } catch {
    /* Node's global navigator may be non-configurable; lottie tolerates its absence. */
  }
  global.HTMLElement = window.HTMLElement;
  global.SVGElement = window.SVGElement;
  global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
  global.cancelAnimationFrame = (id) => clearTimeout(id);

  // jsdom has no canvas backend; satisfy lottie-web's capability probe.
  window.HTMLCanvasElement.prototype.getContext = () => noopContext();

  // eslint-disable-next-line global-require
  _lottie = require("lottie-web/build/player/lottie_light.js");
  return _lottie;
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

function gunzipTgs(buffer) {
  // `.tgs` is gzip; tolerate already-plain JSON too.
  const head = buffer.length >= 2 ? buffer.readUInt16BE(0) : 0;
  if (head === 0x1f8b) {
    return zlib.gunzipSync(buffer);
  }
  const text = buffer.toString("utf8");
  if (text.trimStart().startsWith("{")) return buffer;
  return zlib.gunzipSync(buffer);
}

function renderFrames(animationData, options = {}) {
  const lottie = loadLottie();
  const { window } = _dom;

  return new Promise((resolve, reject) => {
    const container = window.document.createElement("div");
    window.document.body.appendChild(container);

    let animation;
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      try {
        animation?.destroy();
      } catch {
        /* ignore */
      }
      try {
        container.remove();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => done(new Error("Render TGS timeout")), TGS_TIMEOUT_MS);

    try {
      animation = lottie.loadAnimation({
        container,
        renderer: "svg",
        loop: false,
        autoplay: false,
        animationData,
        rendererSettings: { progressiveLoad: false, hideOnTransparent: false },
      });
    } catch (err) {
      clearTimeout(timer);
      done(err);
      return;
    }

    animation.addEventListener("DOMLoaded", () => {
      try {
        const totalFrames = Math.max(1, animation.totalFrames || 1);
        const fr = Number(animation.frameRate) || DEFAULT_FPS;
        const step = Math.max(1, Math.ceil(totalFrames / MAX_FRAMES));
        const frames = [];
        for (let frame = 0; frame < totalFrames; frame += step) {
          animation.goToAndStop(frame, true);
          const svg = container.querySelector("svg");
          if (svg) frames.push(svg.outerHTML);
        }
        clearTimeout(timer);
        done(null, { frames, frameRate: fr, width: animation.animationData.w, height: animation.animationData.h });
      } catch (err) {
        clearTimeout(timer);
        done(err);
      }
    });

    animation.addEventListener("data_failed", () => {
      clearTimeout(timer);
      done(new Error("Data animasi TGS tidak valid"));
    });
  });
}

function rasterizeFrame(svg, outputPath, size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    background: "rgba(0,0,0,0)",
  });
  fs.writeFileSync(outputPath, resvg.render().asPng());
}

async function encodeGif(frameDir, pattern, outputPath, fps) {
  const result = await runProcess(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-framerate",
      String(Math.round(fps)),
      "-i",
      path.join(frameDir, pattern),
      "-vf",
      "scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer",
      "-loop",
      "0",
      outputPath,
    ],
    { timeout: TGS_TIMEOUT_MS, cwd: frameDir },
  );
  if (result.code !== 0) {
    const reason = String(result.stderr || "").trim().split("\n").pop() || "ffmpeg gagal";
    throw new Error(reason.slice(0, 200));
  }
}

/**
 * Convert a `.tgs` sticker file into an animated `.gif`.
 *
 * @param {string} source  Path to the `.tgs` file.
 * @param {string} output  Destination `.gif` path.
 * @param {{size?:number, maxFrames?:number}} [options]
 */
async function tgsToGif(source, output, options = {}) {
  const size = options.size || DEFAULT_SIZE;
  // ffmpeg runs with cwd set to the frame directory, so output must be absolute.
  const outputPath = path.resolve(output);
  const buffer = fs.readFileSync(source);
  const jsonBuffer = gunzipTgs(buffer);

  let animationData;
  try {
    animationData = JSON.parse(jsonBuffer.toString("utf8"));
  } catch {
    throw new Error("File TGS bukan JSON Lottie yang valid");
  }

  const { frames, frameRate } = await renderFrames(animationData, options);
  if (!frames.length) throw new Error("TGS tidak menghasilkan frame");

  const frameDir = fs.mkdtempSync(
    path.join(ensureTempDir() || TEMP_DIR, `tgs_`),
  );
  try {
    frames.forEach((svg, index) => {
      rasterizeFrame(svg, path.join(frameDir, `f${index}.png`), size);
    });
    const fps = Math.min(50, Math.max(5, Math.round(frameRate / Math.max(1, Math.ceil(frameRate / 25)))));
    const effectiveFps = frames.length > 60 ? fps : 25;
    await encodeGif(frameDir, "f%d.png", outputPath, effectiveFps);
  } finally {
    fs.rmSync(frameDir, { recursive: true, force: true });
  }

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error("Konversi TGS ke GIF gagal");
  }
  return outputPath;
}

module.exports = { tgsToGif, gunzipTgs, renderFrames };

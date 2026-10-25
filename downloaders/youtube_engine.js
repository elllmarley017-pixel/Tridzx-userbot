"use strict";
/**
 * YouTube download engine — menggunakan library youtubei.js.
 *
 * library ini menangani client context, API key, dan signature
 * deciphering secara internal. Tidak perlu API key hardcoded.
 */

const { Innertube } = require("youtubei.js");

const VISIONOS_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";

let ytInstance = null;
let ytPending = null;

/**
 * Shared Innertube instance.
 *
 * `Innertube.create()` downloads and evaluates the YouTube player script; the
 * first call can take 30-45s. Concurrent callers must await the same promise,
 * otherwise every parallel command pays that cost again.
 */
async function getInnertube() {
  if (ytInstance) return ytInstance;
  if (!ytPending) {
    ytPending = Innertube.create().then((instance) => {
      ytInstance = instance;
      return instance;
    }).finally(() => {
      ytPending = null;
    });
  }
  return ytPending;
}

/** Warm the instance in the background so the first command is not slow. */
function prewarm() {
  getInnertube().catch(() => {
    /* a failed warm-up must not crash the process; the next call retries */
  });
}

function videoIdFromUrl(input) {
  const text = String(input ?? "").trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.replace(/^\//, "").split("/")[0];
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    const v = url.searchParams.get("v");
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const parts = url.pathname.split("/").filter(Boolean);
    const marker = parts.findIndex((part) => ["shorts", "embed", "live", "v"].includes(part));
    if (marker >= 0 && parts[marker + 1] && /^[\w-]{11}$/.test(parts[marker + 1])) {
      return parts[marker + 1];
    }
  } catch {
    return null;
  }
  return null;
}

function parseMime(mimeType) {
  const [type = "", codecsPart = ""] = String(mimeType || "").split(";");
  const codecsMatch = codecsPart.match(/codecs="([^"]+)"/);
  return {
    container: type.trim() || "application/octet-stream",
    codecs: codecsMatch ? codecsMatch[1].split(",").map((c) => c.trim()) : [],
  };
}

function normalizeFormat(format, resolvedUrl) {
  // youtubei.js v18 uses `mime_type`; older builds used `mimeType`.
  const mime = format.mimeType || format.mime_type || format.type || "";
  const { container, codecs } = parseMime(mime);
  const isVideoOnly = container.startsWith("video/");
  const isAudioOnly = container.startsWith("audio/");
  const hasVideo = isVideoOnly || /video/.test(codecs.join(" "));
  const hasAudio = isAudioOnly || /mp4a|opus|vorbis|aac|flac|audio/.test(codecs.join(" "));
  const quality = format.qualityLabel || format.quality_label || (format.audioQuality ? "audio" : "unknown");
  return {
    itag: format.itag || 0,
    url: resolvedUrl || format.url || null,
    mimeType: mime,
    container: container.split("/")[1] || "bin",
    codecs: codecs.join(", "),
    hasVideo,
    hasAudio,
    combined: hasVideo && hasAudio,
    videoOnly: hasVideo && !hasAudio,
    audioOnly: !hasVideo && hasAudio,
    quality,
    width: format.width ?? format.width_,
    height: format.height ?? format.height_,
    fps: format.fps ?? 0,
    bitrate: format.bitrate ?? 0,
    averageBitrate: format.averageBitrate ?? format.average_bitrate ?? 0,
    audioSampleRate: format.audioSampleRate ?? format.audio_sample_rate ?? 0,
    audioChannels: format.audioChannels ?? format.audio_channels ?? 0,
    contentLength: format.contentLength ?? format.content_length ?? 0,
    language: format.audioTrack?.displayName || null,
  };
}

async function extractInfo(videoOrUrl, options = {}) {
  const videoId = videoIdFromUrl(videoOrUrl);
  if (!videoId) {
    throw new Error("URL YouTube tidak valid");
  }
  const innertube = await getInnertube();
  // The default WEB client returns formats with no `url` and no `cipher`
  // (verified against the live API), which made every download fail. The IOS
  // and MWEB clients return direct URLs, so they are tried in order.
  const clients = options.client ? [options.client] : ["IOS", "MWEB", "ANDROID"];
  let info = null;
  let lastError = null;
  for (const client of clients) {
    try {
      const candidate = await innertube.getInfo(videoId, { ...options, client });
      const data = candidate.streaming_data || {};
      const all = [...(data.formats || []), ...(data.adaptive_formats || [])];
      if (all.some((f) => f.url || f.signature_cipher || f.cipher)) {
        info = candidate;
        break;
      }
      info = info || candidate; // keep the first answer for its error message
    } catch (err) {
      lastError = err;
    }
  }
  if (!info) throw lastError || new Error("Gagal mengambil info video");
  // youtubei.js v18 exposes metadata on `basic_info`; older builds used
  // `video_details`. Reading the wrong one silently produced placeholder titles.
  const details = info.basic_info || info.video_details || {};
  const streaming = info.streaming_data || {};
  const rawFormats = [...(streaming.formats || []), ...(streaming.adaptive_formats || [])];

  // youtubei.js v18 hides the media URL behind an async `decipher(player)`;
  // only a few formats carry a plain `url`. Filtering on `f.url` dropped every
  // format and made every download fail with "no format".
  // `info` does not carry the session; the player lives on the Innertube instance.
  const player = innertube.session?.player;
  const resolved = [];
  for (const raw of rawFormats) {
    let url = raw.url || null;
    if (!url && typeof raw.decipher === "function" && player) {
      try {
        // Must be called on the ORIGINAL Format instance: `decipher` reads
        // private fields (#this_response_nsig_cache) that a spread copy loses.
        url = await raw.decipher(player);
      } catch {
        url = null; // one format may be undecipherable; others still work
      }
    }
    if (!url) continue;
    resolved.push(normalizeFormat(raw, url));
  }
  const formats = resolved;

  // Debug: log format summary.
  const audioCount = formats.filter((f) => f.audioOnly || f.combined).length;
  const videoCount = formats.filter((f) => f.videoOnly || f.combined).length;
  console.error(`[yt engine] id=${videoId} title=${details.title || "?"} formats=${formats.length} audio=${audioCount} video=${videoCount}`);
  for (const f of formats.slice(0, 10)) {
    console.error(`[yt format] itag=${f.itag} mime=${f.mimeType} container=${f.container} audio=${f.hasAudio} video=${f.hasVideo} combined=${f.combined} url=${f.url ? "yes" : "no"}`);
  }

  const status = info.playability_status || {};
  if (!streaming.formats && !streaming.adaptive_formats) {
    const reason = status.reason || status.status || "tidak diketahui";
    throw new Error(`Video tidak dapat diunduh: ${reason}`);
  }

  const title = details.title || "";
  if (!title) {
    // Never invent a title: a placeholder hides a real extraction failure.
    throw new Error("Metadata video tidak tersedia (judul kosong)");
  }
  return {
    id: videoId,
    title,
    description: details.short_description || details.description || "",
    author: details.author || details.channel?.name || details.owner_channel_name || "",
    channelId: details.channel_id || "",
    lengthSeconds: Number(details.duration ?? details.length_seconds) || 0,
    viewCount: Number(details.view_count ?? details.views) || 0,
    thumbnails: (details.thumbnails || []).map((t) => ({
      url: t.url || t.thumbnail_url || "",
      width: t.width || 0,
      height: t.height || 0,
    })),
    isLive: details.is_live || false,
    formats,
    player: info,
  };
}

function chooseFormats(formats, mode = "video", options = {}) {
  if (mode === "audio") {
    // Collect ALL formats that have audio, by flag OR by mime/codec detection.
    const audioCandidates = formats.filter((f) => {
      if (f.audioOnly || f.combined) return true;
      // Fallback: check mime type or codecs directly.
      const mime = (f.mimeType || f.type || "").toLowerCase();
      const codecs = (f.codecs || "").toLowerCase();
      return /audio|mp4a|opus|vorbis|aac|flac/.test(mime) || /audio|mp4a|opus|vorbis|aac|flac/.test(codecs);
    });
    const audio = audioCandidates
      .sort((a, b) => (b.averageBitrate || b.bitrate) - (a.averageBitrate || a.bitrate));

    // Prefer mp4 container, then opus, then webm, then any.
    const preferred =
      audio.find((f) => f.container.includes("mp4")) ||
      audio.find((f) => f.container.includes("opus")) ||
      audio.find((f) => f.container.includes("webm")) ||
      audio[0];
    if (!preferred) throw new Error("Tidak ada format audio yang tersedia");
    return { audio: preferred, video: null, combined: preferred.combined };
  }

  const progressive = formats
    .filter((f) => f.combined)
    .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);

  const audio = formats
    .filter((f) => f.audioOnly)
    .sort((a, b) => (b.averageBitrate || b.bitrate) - (a.averageBitrate || a.bitrate));
  const bestAudio =
    audio.find((f) => f.container.includes("mp4")) || audio[0] || null;

  const videoTiers = formats
    .filter((f) => f.videoOnly)
    .sort((a, b) => b.height - a.height || b.fps - a.fps || b.bitrate - a.bitrate);

  const estimatedBytes = (format) => {
    if (!format) return 0;
    if (format.contentLength) return format.contentLength;
    if (options.duration && format.bitrate) return (format.bitrate / 8) * options.duration;
    return 0;
  };

  const maxSize = options.maxSize ?? Infinity;
  const targetHeight = options.targetHeight ?? Infinity;

  const candidates = [];
  for (const video of videoTiers) {
    if (video.height > targetHeight) continue;
    candidates.push({ video, audio: bestAudio, combined: false });
  }
  for (const combined of progressive) {
    if (combined.height > targetHeight) continue;
    candidates.push({ video: combined, audio: null, combined: true });
  }

  if (!candidates.length) {
    if (videoTiers.length) {
      candidates.push({ video: videoTiers[0], audio: bestAudio, combined: false });
    } else if (progressive.length) {
      candidates.push({ video: progressive[0], audio: null, combined: true });
    } else {
      throw new Error("Tidak ada format video yang tersedia");
    }
  }

  let chosen = null;
  for (const candidate of candidates) {
    const total = estimatedBytes(candidate.video) + estimatedBytes(candidate.audio);
    if (total && total > maxSize) continue;
    chosen = candidate;
    break;
  }
  if (!chosen) {
    chosen = candidates[candidates.length - 1];
  }
  return chosen;
}

async function search(query, options = {}) {
  const innertube = await getInnertube();
  const limit = options.limit ?? 10;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const results = [];
  // A stalled network must surface as an error, not a spinner that never ends.
  const searchResults = await Promise.race([
    innertube.search(query),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Pencarian YouTube timeout setelah ${timeoutMs} ms`)), timeoutMs),
    ),
  ]);

  /** v18 returns RichText objects for text fields; older builds used strings. */
  const asText = (value) => {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.runs)) return value.runs.map((r) => r.text || "").join("");
    return "";
  };

  for (const item of searchResults.results || []) {
    // v18: `video_id`; older: `videoId`. LockupView items have neither.
    const id = item.video_id || item.videoId || (item.type === "Video" ? item.id : null);
    if (!id) continue;
    const title = asText(item.title);
    if (!title) continue;
    const thumbnail =
      item.thumbnails?.[0]?.url ||
      item.thumbnail?.url ||
      (item.rich_thumbnail?.contents?.[0]?.image?.[0]?.url ?? "");
    results.push({
      id,
      title,
      author: asText(item.author?.name ?? item.author),
      duration: asText(item.length_text ?? item.duration?.text ?? item.duration),
      views: asText(item.view_count ?? item.views),
      published: asText(item.published?.text ?? item.published),
      thumbnail,
      url: `https://www.youtube.com/watch?v=${id}`,
    });
    if (results.length >= limit) break;
  }
  return results;
}

module.exports = {
  extractInfo,
  chooseFormats,
  search,
  videoIdFromUrl,
  normalizeFormat,
  getInnertube,
  prewarm,
  VISIONOS_UA,
};

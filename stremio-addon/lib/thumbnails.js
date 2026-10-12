/**
 * Episode thumbnail badges.
 *
 * GET /thumb/<type>.jpg?src=<original thumbnail url>
 *   → the original thumbnail (1280x720) with a CANON / FILLER / MIXED /
 *     ANIME CANON pill drawn in the top-right corner.
 *
 * Responses are cached for a long time on Vercel's CDN, so each image is
 * only generated once.
 */

const fetch = require("node-fetch");
const sharp = require("sharp");
const PILLS = require("./badgePills");

const WIDTH = 1280;
const HEIGHT = 720;
// The badge sits top-centre: that's the only spot every app/layout shows.
// Nuvio's wide cards trim the sides, its list view crops to a centred square,
// and it puts its own watched tick top-right and episode number top-left.
const TOP_INSET = Math.round(HEIGHT * 0.07);
const MAX_SOURCE_BYTES = 6 * 1024 * 1024;

// Only fetch thumbnails from known image hosts so this can't be used as an
// open image proxy.
const ALLOWED_HOSTS = [
  "metahub.space",
  "strem.io",
  "image.tmdb.org",
  "kitsu.app",
  "kitsu.io",
  "thetvdb.com",
  "myanimelist.net",
  "anilist.co",
  "anili.st",
  "fanart.tv",
  "tvmaze.com",
  "imdb.com",
  "media-amazon.com",
  "trakt.tv",
];

// Also allow images hosted by your metadata addon (e.g. AIOMetadata's
// placeholder and blurred-thumbnail images).
try {
  if (process.env.AFC_META_UPSTREAM) {
    ALLOWED_HOSTS.push(new URL(process.env.AFC_META_UPSTREAM.trim()).hostname.toLowerCase());
  }
} catch {}

// Optional extra image CDNs. Keep the allowlist: never turn this into an
// unrestricted server-side image proxy.
for (const entry of (process.env.AFC_IMAGE_HOSTS || "").split(",")) {
  const host = entry.trim().toLowerCase();
  if (/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) {
    ALLOWED_HOSTS.push(host);
  }
}

const SHADOW = PILLS.SHADOW || 0;
const pillBuffers = {};
const pillSizes = {};
for (const [type, entry] of Object.entries(PILLS)) {
  if (!entry || typeof entry !== "object") continue;
  pillBuffers[type] = Buffer.from(entry.png, "base64");
  pillSizes[type] = { w: entry.w, h: entry.h };
}

function isAllowedSource(src) {
  try {
    const u = new URL(src);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (u.username || u.password || (u.port && u.port !== "80" && u.port !== "443")) return false;
    const host = u.hostname.toLowerCase();
    return ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

async function loadSource(src) {
  if (!src || !isAllowedSource(src)) return null;
  // Check every redirect destination before fetching it. The complete chain
  // shares one time budget so a broken CDN cannot stall a Vercel function.
  const deadline = Date.now() + 8000;
  let target = src;
  try {
    for (let redirects = 0; redirects <= 4; redirects++) {
      const timeout = deadline - Date.now();
      if (timeout <= 0 || !isAllowedSource(target)) return null;
      const res = await fetch(target, {
        timeout,
        size: MAX_SOURCE_BYTES,
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; AnimeFillerChecker/1.4.4)",
          Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        if (res.body) res.body.destroy();
        if (!location) return null;
        target = new URL(location, target).href;
        continue;
      }
      if (!res.ok) {
        if (res.body) res.body.destroy();
        return null;
      }
      // Some image proxies send application/octet-stream or omit MIME.
      // Sharp validates the actual bytes instead of trusting this header.
      return await res.buffer();
    }
  } catch {
    return null;
  }
  return null;
}

/** Resolve image fields against the metadata provider, keeping its numbering. */
function getEpisodeThumbnail(video, meta, upstream) {
  function resolve(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value.trim(), upstream || "https://v3-cinemeta.strem.io/");
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
      return url.href;
    } catch { return null; }
  }
  for (const value of [video.thumbnail, video.thumbnail_url, video.image]) {
    const image = resolve(value);
    if (image) return image;
  }
  if (typeof video.still_path === "string" && /^\/[\w.-]+$/.test(video.still_path)) {
    return `https://image.tmdb.org/t/p/w780${video.still_path}`;
  }
  // Missing episode art: preserve existing series art instead of drawing
  // a black rectangle. Do not invent season/episode mappings for other APIs.
  return resolve(meta.background) || resolve(meta.poster);
}

async function renderThumbnail(type, src) {
  const pill = pillBuffers[type];
  if (!pill) return null;

  const { w: pw, h: ph } = pillSizes[type];
  const left = Math.round((WIDTH - pw) / 2);
  const top = TOP_INSET;

  let baseBuf = null;
  const source = await loadSource(src);
  if (source) {
    try {
      baseBuf = await sharp(source, { limitInputPixels: 40000000 })
        .rotate()
        .resize(WIDTH, HEIGHT, { fit: "cover", position: "centre", kernel: "lanczos3" })
        .removeAlpha()
        .toBuffer();
    } catch {
      baseBuf = null;
    }
  }
  if (!baseBuf) return null;

  // Frosted-glass backdrop: blur the area behind the pill, clipped to its shape
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}"><rect width="${pw}" height="${ph}" rx="${ph / 2}" fill="#fff"/></svg>`
  );
  const frosted = await sharp(baseBuf)
    .extract({ left, top, width: pw, height: ph })
    .blur(14)
    .modulate({ brightness: 0.8, saturation: 1.15 })
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();

  return sharp(baseBuf)
    .composite([
      { input: frosted, left, top },
      { input: pill, left: left - SHADOW, top: top - SHADOW },
    ])
    .jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

/**
 * Handle /thumb/<type>.jpg requests. Returns true if the request was handled.
 */
async function handleThumbRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  const match = url.pathname.match(/\/thumb\/([a-z_]+)\.jpg$/);
  if (!match) return false;

  const type = match[1];
  if (!pillBuffers[type]) {
    res.statusCode = 404;
    res.end("unknown badge type");
    return true;
  }

  const src = url.searchParams.get("src");
  try {
    if (!src || !isAllowedSource(src)) {
      res.statusCode = 400;
      res.setHeader("Cache-Control", "no-store");
      res.end("missing or unsupported thumbnail source");
      return true;
    }
    const img = await renderThumbnail(type, src);
    if (!img) {
      // Preserve the original image when a CDN rejects the server-side fetch
      // or an image cannot be decoded. Never cache a synthetic blank result.
      res.statusCode = 302;
      res.setHeader("Location", src);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store");
      res.end();
      return true;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800");
    res.end(img);
  } catch (err) {
    console.error("[THUMB] Error:", err.message);
    res.setHeader("Cache-Control", "no-store");
    if (src && isAllowedSource(src)) {
      res.statusCode = 302;
      res.setHeader("Location", src);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end();
      return true;
    }
    res.statusCode = 500;
    res.end("thumbnail error");
  }
  return true;
}

// Bump when the badge design changes so apps fetch the new images
const BADGE_STYLE = "5";

function buildThumbUrl(baseUrl, type, src) {
  // An unknown CDN can still be displayed directly by the client. Add its
  // hostname to AFC_IMAGE_HOSTS to enable the overlay for that provider.
  if (!pillBuffers[type] || !src || !isAllowedSource(src)) return src || null;
  const q = `?v=${BADGE_STYLE}` + (src ? `&src=${encodeURIComponent(src)}` : "");
  return `${baseUrl}/thumb/${type}.jpg${q}`;
}

module.exports = { handleThumbRequest, buildThumbUrl, renderThumbnail, isAllowedSource, getEpisodeThumbnail };

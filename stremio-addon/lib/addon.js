/**
 * Shared addon builder — used by both local server and Vercel serverless.
 */

const { addonBuilder } = require("stremio-addon-sdk");
const {
  fetchFillerData,
} = require("./fillerData");
const { generateSubtitle, SHORT_LABELS } = require("./subtitles");
const { kvGet, kvSet } = require("./kvCache");
const { buildThumbUrl, getEpisodeThumbnail } = require("./thumbnails");

const fetch = require("node-fetch");

// IMDB ID → AFL slug map (built by scrape-all-shows.js, updated weekly)
let imdbIds = {};
try {
  imdbIds = require("./imdbIds.json");
} catch {}

/* ═══════════════════════════════════════════════════
 *  ADDON MANIFEST
 * ═══════════════════════════════════════════════════ */

// Optional: your metadata addon's manifest URL (e.g. AIOMetadata). When set,
// episode lists come from it (with badges added) instead of Cinemeta/Kitsu.
const META_UPSTREAM = (process.env.AFC_META_UPSTREAM || "")
  .trim()
  .replace(/\/manifest\.json$/i, "")
  .replace(/\/+$/, "");
const META_SOURCES = {
  tt: "https://v3-cinemeta.strem.io",
  kitsu: "https://anime-kitsu.strem.fun",
};
const META_TYPES = ["series", "anime", "anime.series"];
const META_ID_PREFIXES = META_UPSTREAM
  ? ["tt", "kitsu:", "mal:", "anilist:", "anidb:", "tvdb:", "tmdb:", "tvmaze:"]
  : ["tt", "kitsu:"];

const manifest = {
  id: "community.animefiller",
  version: "1.4.4",
  name: "Anime Filler Checker",
  description:
    "Detects filler, canon, mixed, and anime-canon episodes for anime series. " +
    "Shows filler status on episode thumbnails and in the stream list so you know before you hit play. " +
    "Visit animefillerchecker.com for more info and gain access to browser extensions.",
  logo: "https://animefillerchecker.com/icon128.png",
  resources: [
    { name: "meta", types: META_TYPES, idPrefixes: META_ID_PREFIXES },
    "subtitles",
    "stream",
  ],
  types: ["series", "anime"],
  catalogs: [],
  idPrefixes: ["tt", "kitsu:"],
  config: [
    { key: "showCanon", type: "checkbox", title: "✅ CANON — Manga faithful, safe to watch", default: "checked" },
    { key: "showFiller", type: "checkbox", title: "⛔ FILLER — Not from the manga, safe to skip", default: "checked" },
    { key: "showMixed", type: "checkbox", title: "⚠️ MIXED — Contains both canon and filler", default: "checked" },
    { key: "showAnimeCanon", type: "checkbox", title: "🔵 ANIME CANON — Anime-original but plot-relevant", default: "checked" },
    { key: "hideNextTitle", type: "checkbox", title: "🔒 Hide spoilers — Only show episode number in next canon hint" },
    { key: "shortDescription", type: "checkbox", title: "📝 Short Description — Show only CANON / FILLER status, no extra text" },
  ],
  behaviorHints: {
    configurable: true,
    configurationRequired: false,
  },
  homepage: "https://animefillerchecker.com",
  ...(process.env.STREMIO_ADDONS_SIGNATURE && {
    stremioAddonsConfig: {
      issuer: "https://stremio-addons.net",
      signature: process.env.STREMIO_ADDONS_SIGNATURE,
    },
  }),
};

const builder = new addonBuilder(manifest);

/* ═══════════════════════════════════════════════════
 *  HELPERS
 * ═══════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════
 *  MAINTENANCE MODE — set to false to re-enable
 * ═══════════════════════════════════════════════════ */
const MAINTENANCE_MODE = false;

const CONFIG_TYPE_MAP = {
  canon: "showCanon",
  filler: "showFiller",
  mixed: "showMixed",
  anime_canon: "showAnimeCanon",
};

function shouldShowVerdict(config, type) {
  const key = CONFIG_TYPE_MAP[type];
  if (!key) return true;
  if (!config || !(key in config)) return true;
  return !!config[key];
}

const TYPE_EMOJI = {
  canon: "✅",
  filler: "⛔",
  mixed: "⚠️",
  anime_canon: "🔵",
  unknown: "❓",
};

// Cache TTLs
const KITSU_NAME_CACHE_TTL      = 1000 * 60 * 60 * 24 * 7; // 7 days
const CINEMETA_NAME_CACHE_TTL   = 1000 * 60 * 60 * 24 * 7; // 7 days
const ABSOLUTE_EP_CACHE_TTL     = 1000 * 60 * 60 * 24 * 7; // 7 days

// Cache for Kitsu anime names
const kitsuNameCache = new Map();
// Cache for Cinemeta series name lookups (IMDB IDs)
const cinemetaNameCache = new Map();

/* ═══════════════════════════════════════════════════
 *  CACHE STATS — visible in Vercel Function Logs
 * ═══════════════════════════════════════════════════ */
const cacheStats = { hits: 0, misses: 0 };

function cacheHit(label) {
  cacheStats.hits++;
  if (process.env.AFC_CACHE_DEBUG === "1")
    console.log(`[CACHE HIT]  ${label} (hits=${cacheStats.hits} misses=${cacheStats.misses})`);
}

function cacheMiss(label) {
  cacheStats.misses++;
  console.log(`[CACHE MISS] ${label} (hits=${cacheStats.hits} misses=${cacheStats.misses})`);
}

async function resolveAnimeNameFromKitsu(kitsuId) {
  const cached = kitsuNameCache.get(kitsuId);
  if (cached && Date.now() - cached.ts < KITSU_NAME_CACHE_TTL) {
    cacheHit(`kitsu:${kitsuId}`);
    return cached.name;
  }
  // KV layer
  const kvKey = `afc:name:kitsu:${kitsuId}`;
  const kvName = await kvGet(kvKey);
  if (kvName) {
    cacheHit(`kv:kitsu:${kitsuId}`);
    kitsuNameCache.set(kitsuId, { name: kvName, ts: Date.now() });
    return kvName;
  }
  cacheMiss(`kitsu:${kitsuId}`);
  try {
    const res = await fetch(`https://kitsu.io/api/edge/anime/${kitsuId}`);
    if (res.ok) {
      const json = await res.json();
      const name =
        json.data?.attributes?.canonicalTitle ||
        json.data?.attributes?.titles?.en_jp ||
        null;
      if (name) {
        kitsuNameCache.set(kitsuId, { name, ts: Date.now() });
        await kvSet(kvKey, name, 60 * 60 * 24 * 7);
      }
      return name;
    }
  } catch {}
  return null;
}

async function resolveAnimeName(id) {
  // Kitsu ID: "kitsu:12345"
  if (id.startsWith("kitsu:")) {
    return resolveAnimeNameFromKitsu(id.slice("kitsu:".length));
  }
  // IMDB ID: check local imdbIds map first — zero API calls
  if (id.startsWith("tt")) {
    const slug = imdbIds[id];
    if (slug) {
      cacheHit(`imdbIds:${id}`);
      return slug;
    }
    // Not in local map → fall through to Cinemeta lookup below
    cacheMiss(`imdbIds:${id}`);
  }
  // Resolve IMDB ID via Cinemeta (Stremio's default catalog)
  const cachedName = cinemetaNameCache.get(id);
  if (cachedName && Date.now() - cachedName.ts < CINEMETA_NAME_CACHE_TTL) {
    cacheHit(`cinemeta:${id}`);
    return cachedName.name;
  }
  // KV layer
  const safeId = id.replace(/[^a-z0-9]/gi, "_");
  const kvKey = `afc:name:cinemeta:${safeId}`;
  const kvName = await kvGet(kvKey);
  if (kvName) {
    cacheHit(`kv:cinemeta:${id}`);
    cinemetaNameCache.set(id, { name: kvName, ts: Date.now() });
    return kvName;
  }
  cacheMiss(`cinemeta:${id}`);
  try {
    const res = await fetch(
      `https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(id)}.json`
    );
    if (res.ok) {
      const json = await res.json();
      const name = json.meta?.name || null;
      if (name) {
        cinemetaNameCache.set(id, { name, ts: Date.now() });
        await kvSet(kvKey, name, 60 * 60 * 24 * 7);
      }
      return name;
    }
  } catch {}
  return null;
}

/**
 * Parse episode number from Stremio video ID.
 * Cinemeta format: "tt0388629:3:5" = IMDB:season:episode
 */
function parseEpisodeFromVideoId(videoId) {
  const parts = videoId.split(":");
  if (parts.length >= 3) {
    return {
      season: parseInt(parts[1], 10),
      episode: parseInt(parts[2], 10),
    };
  }
  return null;
}

/**
 * Extract the series base ID from a video ID.
 * "tt0388629:3:5" -> "tt0388629"
 * "kitsu:12345:1" -> "kitsu:12345"
 */
function getSeriesId(videoId) {
  if (videoId.startsWith("kitsu:")) {
    const parts = videoId.split(":");
    return `${parts[0]}:${parts[1]}`;
  }
  return videoId.split(":")[0];
}

// Cache for Cinemeta video lists (maps season:ep to absolute ep number)
const absoluteEpCache = new Map();

/**
 * Resolve season:episode to absolute episode number using Cinemeta.
 * Cinemeta returns all videos sorted by season/episode; we count the position.
 */
async function resolveAbsoluteEpisode(seriesId, season, episode) {
  // Kitsu uses absolute episode numbers directly
  if (seriesId.startsWith("kitsu:")) return episode;

  const cacheKey = seriesId;
  const cachedEntry = absoluteEpCache.get(cacheKey);
  let mapping =
    cachedEntry && Date.now() - cachedEntry.ts < ABSOLUTE_EP_CACHE_TTL
      ? cachedEntry.mapping
      : null;

  if (!mapping) {
    // KV layer — stored as plain object, restore to Map
    const safeId = seriesId.replace(/[^a-z0-9]/gi, "_");
    const kvKey = `afc:abep:${safeId}`;
    const kvObj = await kvGet(kvKey);
    if (kvObj && typeof kvObj === "object") {
      mapping = new Map(Object.entries(kvObj));
      absoluteEpCache.set(cacheKey, { mapping, ts: Date.now() });
    }
  }

  if (!mapping) {
    try {
      const res = await fetch(
        `https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(seriesId)}.json`
      );
      if (!res.ok) return episode; // fallback to relative
      const json = await res.json();
      const videos = json.meta?.videos;
      if (!videos || !videos.length) return episode;

      // Sort by season then episode, assign absolute numbers
      mapping = new Map();
      const sorted = videos
        .filter((v) => v.season && v.season > 0 && v.episode && v.episode > 0)
        .sort((a, b) => a.season - b.season || a.episode - b.episode);

      sorted.forEach((v, i) => {
        mapping.set(`${v.season}:${v.episode}`, i + 1);
      });

      absoluteEpCache.set(cacheKey, { mapping, ts: Date.now() });
      // Persist to KV as plain object
      const safeId = seriesId.replace(/[^a-z0-9]/gi, "_");
      await kvSet(`afc:abep:${safeId}`, Object.fromEntries(mapping), 60 * 60 * 24 * 7);
    } catch {
      return episode; // fallback
    }
  }

  return mapping.get(`${season}:${episode}`) || episode;
}

/* ═══════════════════════════════════════════════════
 *  META HANDLER — Filler badges on episode thumbnails
 *
 *  Gets the normal series details from your metadata addon, swaps each
 *  episode thumbnail for a badged version, and passes it on.
 *
 *  Where the details come from:
 *   • AFC_META_UPSTREAM set (e.g. your AIOMetadata manifest URL) → that addon,
 *     so you keep its descriptions, ratings and artwork.
 *   • Otherwise → Cinemeta for tt IDs, the Kitsu addon for kitsu: IDs.
 *
 *  For anything that isn't an anime on AnimeFillerList it answers "not
 *  found", so Stremio / Nuvio fall back to your next metadata addon.
 * ═══════════════════════════════════════════════════ */

const ANIME_ONLY_PREFIXES = ["kitsu:", "mal:", "anilist:", "anidb:"];
const META_CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours
const metaCache = new Map();

let publicBaseUrl =
  process.env.AFC_BASE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `http://127.0.0.1:${process.env.PORT || 7000}`);

function setPublicBaseUrl(url) {
  if (url && !process.env.AFC_BASE_URL) publicBaseUrl = url.replace(/\/+$/, "");
}

function notFound(reason) {
  const err = new Error(reason);
  err.noHandler = true; // SDK answers 404 → the app uses the next addon
  return err;
}

async function fetchBaseMeta(type, id) {
  const key = `${type}/${id}`;
  const cached = metaCache.get(key);
  if (cached && Date.now() - cached.ts < META_CACHE_TTL) return cached.meta;

  let url;
  if (META_UPSTREAM) {
    url = `${META_UPSTREAM}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  } else {
    const source = id.startsWith("kitsu:") ? META_SOURCES.kitsu : META_SOURCES.tt;
    url = `${source}/meta/series/${encodeURIComponent(id)}.json`;
  }

  let meta = null;
  try {
    const res = await fetch(url, { timeout: 9000 });
    if (res.ok) meta = (await res.json()).meta || null;
  } catch {}
  metaCache.set(key, { meta, ts: Date.now() });
  return meta;
}

function looksLikeAnime(meta, id, type) {
  if (type !== "series") return true; // "anime" / "anime.series"
  if (ANIME_ONLY_PREFIXES.some((p) => id.startsWith(p))) return true;
  if (imdbIds[id] || (meta.imdb_id && imdbIds[meta.imdb_id])) return true;
  const genres = (meta.genres || meta.genre || []).map((g) => String(g).toLowerCase());
  const country = String(meta.country || "").toLowerCase();
  return (
    genres.includes("animation") ||
    genres.includes("anime") ||
    country.includes("japan") ||
    !!meta.mal_id ||
    !!meta.kitsu_id
  );
}

/**
 * Work out the absolute episode number (the numbering AnimeFillerList uses)
 * for each video in the list.
 */
async function mapAbsoluteEpisodes(meta, id) {
  const imdbId = meta.imdb_id || (id.startsWith("tt") ? id.split(":")[0] : null);
  const absolute = new Map();

  // 1. Use IMDb season/episode where the metadata gives it, numbered the same
  //    way as the stream badges (Cinemeta order).
  if (imdbId) {
    for (const v of meta.videos) {
      let s = v.imdbSeason, e = v.imdbEpisode;
      if ((!s || !e) && typeof v.id === "string" && v.id.startsWith(imdbId + ":")) {
        const parts = v.id.split(":");
        s = parseInt(parts[1], 10);
        e = parseInt(parts[2], 10);
      }
      if (s > 0 && e > 0) absolute.set(v.id, await resolveAbsoluteEpisode(imdbId, s, e));
    }
  }

  // 2. Otherwise count through the list in season/episode order
  //    (kitsu:/mal: lists are already numbered 1..N).
  meta.videos
    .filter((v) => v.season > 0 && v.episode > 0)
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
    .forEach((v, i) => {
      if (!absolute.has(v.id)) absolute.set(v.id, i + 1);
    });

  return { absolute, imdbId };
}

builder.defineMetaHandler(async ({ type, id, config }) => {
  if (MAINTENANCE_MODE || !META_TYPES.includes(type)) throw notFound("unsupported");

  const base = await fetchBaseMeta(type, id);
  if (!base || !Array.isArray(base.videos) || !base.videos.length) throw notFound("no meta");
  if (!looksLikeAnime(base, id, type)) throw notFound("not anime");

  const { absolute, imdbId } = await mapAbsoluteEpisodes(base, id);

  // Find the show on AnimeFillerList: try the IMDb title first (covers the
  // whole series), then the name shown by the metadata addon.
  let fillerData = null;
  const names = [];
  if (imdbId) names.push(await resolveAnimeName(imdbId));
  names.push(base.name);
  for (const name of [...new Set(names.filter(Boolean))]) {
    fillerData = await fetchFillerData(name).catch(() => null);
    if (fillerData && fillerData.totalEpisodes) break;
  }
  if (!fillerData || !fillerData.totalEpisodes) throw notFound("no filler data");

  let badged = 0;
  const videos = base.videos.map((v) => {
    const abs = absolute.get(v.id);
    const ep = abs && fillerData.episodes[abs];
    if (!ep || !TYPE_EMOJI[ep.type] || ep.type === "unknown") return v;
    if (!shouldShowVerdict(config, ep.type)) return v;
    badged++;
    const source = getEpisodeThumbnail(v, base, META_UPSTREAM);
    const thumbnail = buildThumbUrl(publicBaseUrl, ep.type, source);
    return thumbnail ? { ...v, thumbnail } : v;
  });

  if (!badged) throw notFound("no matching episodes");

  return {
    meta: { ...base, videos },
    cacheMaxAge: 60 * 5,
    staleRevalidate: 60 * 60 * 24,
    staleError: 60 * 60 * 24 * 7,
  };
});

/* ═══════════════════════════════════════════════════
 *  SUBTITLES HANDLER
 * ═══════════════════════════════════════════════════ */
builder.defineSubtitlesHandler(async ({ type, id, config }) => {
  if (MAINTENANCE_MODE) return { subtitles: [] };
  if (type !== "series") return { subtitles: [] };

  try {
    const parsed = parseEpisodeFromVideoId(id);
    if (!parsed) return { subtitles: [] };

    const seriesId = getSeriesId(id);

    const animeName = await resolveAnimeName(seriesId);
    if (!animeName) return { subtitles: [] };

    const epNum = await resolveAbsoluteEpisode(seriesId, parsed.season, parsed.episode);

    const fillerData = await fetchFillerData(animeName);
    if (!fillerData || fillerData.totalEpisodes === 0) {
      return { subtitles: [] };
    }

    const episode = fillerData.episodes[epNum];
    if (!episode) return { subtitles: [] };

    if (!shouldShowVerdict(config, episode.type)) return { subtitles: [] };

    let nextCanon = null;
    if (episode.type === "filler" || episode.type === "mixed") {
      for (let n = epNum + 1; n <= fillerData.totalEpisodes; n++) {
        const candidate = fillerData.episodes[n];
        if (!candidate) break;
        if (candidate.type !== "filler") {
          nextCanon = candidate;
          break;
        }
      }
    }

    const srtContent = generateSubtitle(episode, { nextCanon, hideNextTitle: !!config?.hideNextTitle, shortDescription: !!config?.shortDescription });
    const label = SHORT_LABELS[episode.type] || "UNKNOWN";
    const emoji = TYPE_EMOJI[episode.type] || "❓";
    const srtBase64 = Buffer.from(srtContent, "utf-8").toString("base64");

    return {
      subtitles: [
        {
          id: `afc-${seriesId}-s${id.split(":")[1] || 1}-e${epNum}`,
          url: `data:text/srt;base64,${srtBase64}`,
          lang: "Filler Check",
          name: `${emoji} ${label}`,
        },
      ],
    };
  } catch (err) {
    console.error(`[SUBTITLES] Error for ${id}:`, err.message);
    return { subtitles: [] };
  }
});

/* ═══════════════════════════════════════════════════
 *  STREAM HANDLER — Filler status badge in stream list
 * ═══════════════════════════════════════════════════ */

const STREAM_LABELS = {
  canon:      "📝 Aus Manga adaptiert",
  filler:     "📝 Nicht aus Manga, sicher zu überspringen",
  mixed:      "📝 Gemischter Inhalt, lieber anschauen",
  anime_canon:"📝 Plot relevant",
  unknown:    "📝 Keine Daten abrufbar",
};

builder.defineStreamHandler(async ({ type, id, config }) => {
  if (MAINTENANCE_MODE) return {
    streams: [{
      name: "🚧 ADDON DISABLED",
      description: "AnimeFillerChecker addon is currently disabled indefinitely.\nThere were too many requests coming in and my Vercel deployment can't provide it anymore. Until I find a sustainable hosting solution, the Stremio addon will stay offline.\nThe browser extension at animefillerchecker.com still works for filler info, visit the site for updates.\nIn the meantime you can still host the stremio addon on your local device on your own if you want.\n\nhttps://github.com/nehirakbass/anime-filler-checker",
      externalUrl: "https://github.com/nehirakbass/anime-filler-checker",
    }],
  };
  if (type !== "series") return { streams: [] };

  try {
    const parsed = parseEpisodeFromVideoId(id);
    if (!parsed) return { streams: [] };

    const seriesId = getSeriesId(id);
    const animeName = await resolveAnimeName(seriesId);
    if (!animeName) return { streams: [] };

    const epNum = await resolveAbsoluteEpisode(seriesId, parsed.season, parsed.episode);

    const fillerData = await fetchFillerData(animeName);
    if (!fillerData || fillerData.totalEpisodes === 0) return { streams: [] };

    const episode = fillerData.episodes[epNum];
    if (!episode) return { streams: [] };

    if (!shouldShowVerdict(config, episode.type)) return { streams: [] };

    const label = STREAM_LABELS[episode.type] || STREAM_LABELS.unknown;
    const emoji = TYPE_EMOJI[episode.type] || "❓";
    const shortLabel = SHORT_LABELS[episode.type] || "UNKNOWN";

    let description = config?.shortDescription ? `${emoji} ${shortLabel}` : label;
    let episodePositions = new Map();
    
    try {
      const baseMeta = await fetchBaseMeta("series", seriesId);
    
      if (baseMeta?.videos?.length) {
        const { absolute } = await mapAbsoluteEpisodes(baseMeta, seriesId);
    
        for (const video of baseMeta.videos) {
          const abs = absolute.get(video.id);
          const season = Number(video.imdbSeason || video.season);
          const ep = Number(video.imdbEpisode || video.episode);
    
          if (abs && season > 0 && ep > 0 && !episodePositions.has(abs)) {
            episodePositions.set(abs, { season, episode: ep });
          }
        }
      }
    } catch (err) {
      console.error("[STREAM] Season mapping:", err.message);
    }

    if (episode.type === "filler" || episode.type === "mixed") {
      for (let n = epNum + 1; n <= fillerData.totalEpisodes; n++) {
        const candidate = fillerData.episodes[n];
        if (!candidate) break;
        if (candidate.type !== "filler") {
        const position = episodePositions.get(n);
        
        const nextLabel = position
          ? `Staffel ${position.season}, Episode ${position.episode}`
          : `Episode ${candidate.number}`;
          description += `\n🔎 Nächste Canon Episode: ${nextLabel}`;
          break;
        }
      }
    }

    return {
      streams: [
        {
          name: `${emoji} ${shortLabel}`,
          description,
          externalUrl: `stremio:///detail/series/${seriesId}`,
        },
      ],
    };
  } catch (err) {
    console.error(`[STREAM] Error for ${id}:`, err.message);
    return { streams: [] };
  }
});

module.exports = builder;
module.exports.MAINTENANCE_MODE = MAINTENANCE_MODE;
module.exports.setPublicBaseUrl = setPublicBaseUrl;

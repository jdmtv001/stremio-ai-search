const { addonBuilder } = require("stremio-addon-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fetch = require("node-fetch").default;
const logger = require("./utils/logger");
const path = require("path");
const { decryptConfig } = require("./utils/crypto");
const { withRetry } = require("./utils/apiRetry");
const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 day cache for TMDB
const TMDB_DISCOVER_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 day cache for TMDB discover (was 12 hours)
const AI_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 day cache for AI
const RPDB_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 day cache for RPDB
const DEFAULT_RPDB_KEY = process.env.RPDB_API_KEY;
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === "true" || false;
const TRAKT_API_BASE = "https://api.trakt.tv";
const TRAKT_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
const TRAKT_RAW_DATA_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const TRAKT_CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET;
const TRAKT_REDIRECT_URI = "https://stremio.itcon.au/aisearch/trakt/redirect";

const LruCache = require("lru-cache");
const tmdbCache = new LruCache({ max: 500, ttl: TMDB_CACHE_DURATION });
const tmdbDiscoverCache = new LruCache({
  max: 500,
  ttl: TMDB_DISCOVER_CACHE_DURATION,
});
const aiCache = new LruCache({ max: 500, ttl: AI_CACHE_DURATION });
const rpdbCache = new LruCache({ max: 500, ttl: RPDB_CACHE_DURATION });
const traktCache = new LruCache({ max: 500, ttl: TRAKT_CACHE_DURATION });
const traktRawDataCache = new LruCache({
  max: 500,
  ttl: TRAKT_RAW_DATA_CACHE_DURATION,
});
const queryAnalysisCache = new LruCache({
  max: 500,
  ttl: 12 * 60 * 60 * 1000,
}); // 12 hours

const addonName = "Stremio AI Search";
const addonId = `com.stremio.aisearch.${process.env.APP_ID || "dev"}`;
let apiKeyFromConfig = process.env.TMDB_API_KEY;

const builder = new addonBuilder({
  id: addonId,
  name: addonName,
  version: "1.0.0",
  catalogs: [
    {
      id: "ai-search-movies",
      type: "movie",
      name: "AI Search Movies",
    },
    {
      id: "ai-search-series",
      type: "series",
      name: "AI Search Series",
    },
  ],
  resources: ["stream", "meta", "catalog", "subtitles", "search"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  description: "AI-powered movie and series recommendations for Stremio",
  icon: "https://stremio.itcon.au/aisearch/favicon.ico",
});

const isProd = process.env.NODE_ENV === "production";
let aiModel = "gemini-1.5-pro";
const numRecommendations = 20;

const addonInterface = builder.get ");

// --- Addon Handlers ---
builder.defineCatalogHandler(async ({ id, type, extra }) => {
  logger.debug("Catalog handler called", { id, type, extra });
  const { query, genre } = extra;

  if (id === "ai-search-movies" || id === "ai-search-series") {
    // Generate AI recommendations
    const items = await catalogHandler(type, genre);
    logger.debug("Returning catalog items", { count: items.length });
    return Promise.resolve({
      metas: items,
      cacheMaxAge: TMDB_DISCOVER_CACHE_DURATION / 1000,
    });
  }

  return Promise.resolve({
    metas: [],
    cacheMaxAge: 60 * 60,
  });
});

async function catalogHandler(type, genre) {
  try {
    let metas = [];
    const genreMap = {
      action: 28,
      adventure: 12,
      animation: 16,
      comedy: 35,
      crime: 80,
      documentary: 99,
      drama: 18,
      family: 10751,
      fantasy: 14,
      history: 36,
      horror: 27,
      music: 10402,
      mystery: 9648,
      romance: 10749,
      "science fiction": 878,
      "tv movie": 10770,
      thriller: 53,
      war: 10752,
      western: 37,
    };
    const genreId = genreMap[genre.toLowerCase()];
    if (genreId) {
      metas = await discoverTypeAndGenres(type, genreId);
    }
    return metas;
  } catch (error) {
    logger.error("Error in catalog handler:", { error });
    return [];
  }
}

async function discoverTypeAndGenres(type, genreId) {
  const cacheKey = `discover_${type}_${genreId}`;
  const cachedData = tmdbDiscoverCache.get(cacheKey);
  if (cachedData) {
    logger.debug(`Returning TMDB discover from cache for ${cacheKey}`);
    return cachedData;
  }

  try {
    const params = new URLSearchParams({
      api_key: apiKeyFromConfig,
      language: "en-US",
      sort_by: "popularity.desc",
      include_adult: "false",
      include_video: "false",
      page: "1",
      with_genres: genreId,
    });
    const url = `${TMDB_API_BASE}/discover/${type}?${params.toString()}`;

    const response = await withRetry(() => fetch(url), 3);
    if (!response.ok) {
      throw new Error(
        `TMDB API discover error: ${response.status} ${response.statusText}`
      );
    }
    const data = await response.json();
    if (!data.results || data.results.length === 0) {
      return [];
    }

    const allResults = data.results.map((item) => {
      const isMovie = type === "movie";
      return {
        id: `tt${item.id}`,
        type: type,
        name: isMovie ? item.title : item.name,
        poster: item.poster_path
          ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
          : null,
        description: item.overview,
        posterShape: "regular",
      };
    });

    tmdbDiscoverCache.set(cacheKey, allResults);
    logger.debug(`Cached TMDB discover results for ${cacheKey}`);

    if (allResults.length > numRecommendations) {
      const shuffled = allResults.sort(() => 0.5 - Math.random());
      const randomSelection = shuffled.slice(0, numRecommendations);
      return randomSelection;
    }

    return allResults;
  } catch (error) {
    logger.error("TMDB discover API Error:", {
      error: error.message,
      stack: error.stack,
    });
    return [];
  }
}

function getRpdbTierFromApiKey(apiKey) {
  if (!apiKey) return -1;
  try {
    const tierMatch = apiKey.match(/^t(\d+)-/);
    if (tierMatch && tierMatch[1] !== undefined) {
      return parseInt(tierMatch[1]);
    }
    return -1;
  } catch (error) {
    logger.error("Error parsing RPDB tier from API key", {
      error: error.message,
    });
    return -1;
  }
}
module.exports = {
  builder,
  addonInterface,
  catalogHandler,
  clearTmdbCache,
  clearTmdbDetailsCache,
  clearTmdbDiscoverCache,
  clearAiCache,
  removeAiCacheByKeywords,
  clearRpdbCache,
  clearTraktCache,
  clearTraktRawDataCache,
  clearQueryAnalysisCache,
  getCacheStats,
  serializeAllCaches,
  deserializeAllCaches,
  discoverTypeAndGenres,
  filterTraktDataBy...
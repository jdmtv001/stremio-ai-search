const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');

const addonId = `com.stremio.aisearch.${process.env.APP_ID || 'dev'}`;
const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days
const LruCache = require('lru-cache');
const tmdbDiscoverCache = new LruCache({ max: 500, ttl: TMDB_CACHE_DURATION });

const builder = new addonBuilder({
  id: addonId,
  name: 'Stremio AI Search',
  version: '1.0.0',
  catalogs: [
    { id: 'ai-search-movies', type: 'movie', name: 'AI Search Movies' },
    { id: 'ai-search-series', type: 'series', name: 'AI Search Series' },
  ],
  resources: ['catalog', 'meta'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  description: 'AI-powered movie and series recommendations for Stremio',
  icon: 'https://stremio.itcon.au/aisearch/favicon.ico',
});

async function catalogHandler({ type, extra, search }, { stremioConfig }) {
  console.log('Catalog handler called:', { type, extra, search });
  try {
    const config = JSON.parse(stremioConfig || '{}');
    const tmdbApiKey = config.TmdbApiKey;

    if (!tmdbApiKey) {
      console.error('TMDB API key missing in catalogHandler.');
      return { metas: [], error: 'TMDB API key required.' };
    }

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
      'science fiction': 878,
      'tv movie': 10770,
      thriller: 53,
      war: 10752,
      western: 37,
    };

    const genre = extra?.genre?.toLowerCase();
    const genreId = genre ? genreMap[genre] : null;
    let metas = [];

    if (genreId) {
      metas = await discoverTypeAndGenres(type, genreId, tmdbApiKey);
    } else {
      metas = [];
      console.log('No genre provided or genre not found in map.');
    }

    return { metas, error: null };
  } catch (error) {
    console.error('Error in catalogHandler:', error.message, error.stack);
    return { metas: [], error: error.message };
  }
}

async function discoverTypeAndGenres(type, genreId, tmdbApiKey) {
  const cacheKey = `discover_${type}_${genreId}`;
  const cachedData = tmdbDiscoverCache.get(cacheKey);
  if (cachedData) {
    console.log(`Returning cached TMDB data for ${cacheKey}`);
    return cachedData;
  }

  try {
    const params = new URLSearchParams({
      api_key: tmdbApiKey,
      language: 'en-US',
      sort_by: 'popularity.desc',
      include_adult: 'false',
      include_video: 'false',
      page: '1',
      with_genres: genreId,
    });
    const url = `${TMDB_API_BASE}/discover/${type}?${params.toString()}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`TMDB API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (!data.results || data.results.length === 0) {
      console.log('No results from TMDB API.');
      return [];
    }

    const metas = data.results.map(item => ({
      id: `tt${item.id}`,
      type: type,
      name: type === 'movie' ? item.title : item.name,
      poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
      description: item.overview,
      posterShape: 'regular',
    }));

    tmdbDiscoverCache.set(cacheKey, metas);
    console.log(`Cached TMDB results for ${cacheKey}`);
    return metas.slice(0, 20);
  } catch (error) {
    console.error('TMDB discover error:', error.message, error.stack);
    return [];
  }
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log('Builder catalog handler:', { type, id, extra });
  const config = {
    stremioConfig: JSON.stringify({
      TmdbApiKey: currentApiKeys.tmdbApiKey,
      GeminiApiKey: currentApiKeys.geminiApiKey,
      RpdbApiKey: currentApiKeys.rpdbApiKey,
    }),
  };
  const { metas, error } = await catalogHandler({ type, extra, search: extra?.search }, config);
  return { metas, cacheMaxAge: TMDB_CACHE_DURATION / 1000 };
});

module.exports = { catalogHandler };
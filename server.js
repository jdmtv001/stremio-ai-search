// server.js
require('dotenv').config(); // Load .env for local development; Render uses dashboard env vars

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

// Log startup for debugging
console.log('Starting server.js...');
console.log('Environment Variables:', {
  firebaseConfig: process.env.__firebase_config ? 'Present' : 'Missing',
  appId: process.env.__app_id || 'default-addon-id-for-dev',
  port: process.env.PORT || 3000
});

// Global variables for Firebase configuration
const firebaseConfigRaw = process.env.__firebase_config || '{}';
const appId = process.env.__app_id || 'default-addon-id-for-dev';

// Initialize Firebase with robust error handling
let db = null;
try {
  const firebaseConfig = JSON.parse(firebaseConfigRaw);
  if (Object.keys(firebaseConfig).length > 0 && firebaseConfig.projectId) {
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig)
    });
    db = getFirestore();
    console.log('Firebase Admin SDK initialized successfully.');
  } else {
    console.warn('Firebase Admin SDK not initialized: Missing or invalid __firebase_config.');
  }
} catch (error) {
  console.error('Firebase Admin SDK initialization failed:', error.message, error.stack);
  // Continue without crashing
}

// Global API Key Storage
let currentApiKeys = {
  geminiApiKey: process.env.GEMINI_API_KEY || null,
  tmdbApiKey: process.env.TMDB_API_KEY || null,
  rpdbApiKey: process.env.RPDB_API_KEY || null,
};

// Log initial API keys
console.log('Initial API Keys:', {
  geminiApiKey: currentApiKeys.geminiApiKey ? 'Present' : 'Missing',
  tmdbApiKey: currentApiKeys.tmdbApiKey ? 'Present' : 'Missing',
  rpdbApiKey: currentApiKeys.rpdbApiKey ? 'Present' : 'Missing'
});

const ADDON_CONFIG_FIRESTORE_USER_ID = 'global_addon_config';

async function loadApiKeysFromFirestore() {
  if (!db) {
    console.warn('Firestore instance not available. Using environment variables.');
    return;
  }
  try {
    const configDocRef = db.collection('artifacts').doc(appId)
      .collection('users').doc(ADDON_CONFIG_FIRESTORE_USER_ID)
      .collection('addon_config').doc('api_keys');
    const docSnap = await configDocRef.get();

    if (docSnap.exists) {
      const data = docSnap.data();
      currentApiKeys.geminiApiKey = data.geminiApiKey || currentApiKeys.geminiApiKey;
      currentApiKeys.tmdbApiKey = data.tmdbApiKey || currentApiKeys.tmdbApiKey;
      currentApiKeys.rpdbApiKey = data.rpdbApiKey || currentApiKeys.rpdbApiKey;
      console.log('Global API keys loaded from Firestore.');
    } else {
      console.log('No global API keys found in Firestore. Using environment variables.');
    }
  } catch (error) {
    console.error('Error loading global API keys from Firestore:', error.message, error.stack);
    console.warn('Falling back to environment variables.');
  }
}

loadApiKeysFromFirestore().then(() => {
  console.log('loadApiKeysFromFirestore completed.');
}).catch(err => {
  console.error('loadApiKeysFromFirestore failed:', err.message, err.stack);
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

function getBaseUrl(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}`;
}

app.get('/', (req, res) => {
  res.redirect('/configure');
});

app.get('/manifest.json', (req, res) => {
  const manifest = {
    id: `com.gemini.stremio.recommender.${appId}`,
    version: "1.0.0",
    name: `Gemini AI Addon (${appId.substring(0, 8)})`,
    description: "Stremio addon powered by Google Gemini AI for personalized movie/series recommendations and enhanced search.",
    logo: `https://placehold.co/120x120/ADD8E6/00008B?text=AI+Addon`,
    background: `https://placehold.co/1000x500/ADD8E6/00008B?text=Stremio+AI+Addon`,
    resources: ["catalog", "meta"],
    types: ["movie", "series"],
    idProperty: "imdb_id",
    catalogs: [
      {
        type: "movie",
        id: "gemini_movie_recommendations",
        name: "Gemini Movie Recs",
        extraRequired: ["search"],
        extraSupported: ["search"]
      },
      {
        type: "series",
        id: "gemini_series_recommendations",
        name: "Gemini Series Recs",
        extraRequired: ["search"],
        extraSupported: ["search"]
      }
    ],
    dontAnnounce: false,
    config: []
  };
  res.json(manifest);
});

app.get('/catalog/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const { search, extra } = req.query;

  console.log(`Catalog request: Type=${type}, Catalog ID=${id}, Search Query=${search || 'N/A'}`);

  await loadApiKeysFromFirestore();

  const configData = {
    GeminiApiKey: currentApiKeys.geminiApiKey,
    TmdbApiKey: currentApiKeys.tmdbApiKey,
    RpdbApiKey: currentApiKeys.rpdbApiKey,
  };

  if (!configData.GeminiApiKey || !configData.TmdbApiKey) {
    console.error('Missing critical API keys (Gemini or TMDB).');
    return res.json({
      metas: [{
        id: `tt_missing_keys`,
        type: type,
        name: `Configuration Required`,
        poster: `https://placehold.co/200x300/DC143C/FFFFFF?text=MISSING+KEYS`,
        posterShape: "regular",
        description: "Please configure API keys at /configure.",
        genres: ["Error"]
      }]
    });
  }

  let addon;
  try {
    addon = require('./addon');
  } catch (error) {
    console.error('Failed to load addon.js:', error.message, error.stack);
    return res.status(500).json({ metas: [], error: 'Failed to load addon logic.' });
  }

  try {
    const { metas, error } = await addon.catalogHandler({ type, extra, search }, { stremioConfig: JSON.stringify(configData) });
    if (error) {
      console.error('Error from catalogHandler:', error);
      return res.status(500).json({ metas: [], error });
    }
    res.json({ metas });
  } catch (handlerError) {
    console.error('Unhandled error in catalogHandler:', handlerError.message, handlerError.stack);
    res.status(500).json({ metas: [], error: 'Unexpected error in addon logic.' });
  }
});

app.get('/meta/:type/:imdb_id.json', (req, res) => {
  const { type, imdb_id } = req.params;
  console.log(`Meta request: Type=${type}, IMDb ID=${imdb_id}`);

  const mockMeta = {
    id: imdb_id,
    type: type,
    name: `Dynamic ${type === 'movie' ? 'Film' : 'Show'} - ${imdb_id}`,
    poster: `https://placehold.co/200x300/6495ED/00008B?text=Poster`,
    background: `https://placehold.co/1000x500/6495ED/00008B?text=Background`,
    description: `Detailed description for ${imdb_id}.`,
    releaseInfo: "2024",
    genres: ["AI-Generated Pick"],
    director: ["AI Visionary"],
    cast: ["Digital Actor 1"],
    imdbRating: "8.5",
    runtime: "150 min",
    trailer: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  };

  res.json({ meta: mockMeta });
});

app.post('/save-config', async (req, res) => {
  const { geminiApiKey, tmdbApiKey, rpdbApiKey } = req.body;

  if (!db) {
    return res.status(500).json({ error: 'Firestore not initialized.' });
  }
  if (!geminiApiKey || !tmdbApiKey) {
    return res.status(400).json({ error: 'Gemini and TMDB API keys are required.' });
  }

  try {
    const configDocRef = db.collection('artifacts').doc(appId)
      .collection('users').doc(ADDON_CONFIG_FIRESTORE_USER_ID)
      .collection('addon_config').doc('api_keys');
    await configDocRef.set({
      geminiApiKey,
      tmdbApiKey,
      rpdbApiKey: rpdbApiKey || null,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    currentApiKeys.geminiApiKey = geminiApiKey;
    currentApiKeys.tmdbApiKey = tmdbApiKey;
    currentApiKeys.rpdbApiKey = rpdbApiKey;

    console.log('API keys saved to Firestore.');
    res.json({ success: true, message: 'API keys saved!' });
  } catch (error) {
    console.error('Error saving API keys:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to save API keys.' });
  }
});

app.get('/get-config', async (req, res) => {
  if (!db) {
    console.warn('Firestore not available. Returning empty config.');
    return res.json({});
  }
  try {
    const configDocRef = db.collection('artifacts').doc(appId)
      .collection('users').doc(ADDON_CONFIG_FIRESTORE_USER_ID)
      .collection('addon_config').doc('api_keys');
    const docSnap = await configDocRef.get();

    if (docSnap.exists) {
      const data = docSnap.data();
      res.json({
        geminiApiKey: data.geminiApiKey || '',
        tmdbApiKey: data.tmdbApiKey || '',
        rpdbApiKey: data.rpdbApiKey || ''
      });
      console.log('Config retrieved from Firestore.');
    } else {
      res.json({});
      console.log('No config found in Firestore.');
    }
  } catch (error) {
    console.error('Error retrieving config:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to retrieve configuration.' });
  }
});

// /configure endpoint (React frontend)
app.get('/configure', (req, res) => {
  const firebaseConfigJson = process.env.__firebase_config ? JSON.stringify(JSON.parse(process.env.__firebase_config)) : '{}';
  const initialAuthToken = process.env.__initial_auth_token || undefined;
  const currentAppId = process.env.__app_id || 'default-addon-id';

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Stremio Gemini Addon Configuration</title>
      <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
      <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
      <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
      <script src="https://cdn.tailwindcss.com"></script>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
      <style>
        body {
          font-family: 'Inter', sans-serif;
          background-color: #E3F2FD;
          color: #1A237E;
        }
        .container {
          max-width: 800px;
        }
        input[type="text"], input[type="password"] {
          background-color: #BBDEFB;
          border: 1px solid #64B5F6;
          color: #1A237E;
          padding: 0.5rem 0.75rem;
          border-radius: 0.375rem;
          width: 100%;
          transition: all 0.2s ease-in-out;
        }
        input[type="text"]:focus, input[type="password"]:focus {
          outline: none;
          box-shadow: 0 0 0 2px rgba(33, 150, 243, 0.5);
        }
        button {
          background-color: #1976D2;
          color: white;
          padding: 0.625rem 1rem;
          border-radius: 0.375rem;
          font-weight: 600;
          transition: all 0.3s ease-in-out;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }
        button:hover {
          background-color: #1565C0;
          transform: scale(1.02);
        }
        .message-box {
          padding: 1rem;
          border-radius: 0.5rem;
          width: 100%;
          max-width: 40rem;
          text-align: center;
          font-weight: 500;
        }
        .success { background-color: #4CAF50; color: white; }
        .error { background-color: #F44336; color: white; }
        .info { background-color: #2196F3; color: white; }
      </style>
      <script type="module">
        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
        import { getAuth, signInAnonymously, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
        import { getFirestore, doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

        const firebaseConfig = ${firebaseConfigJson};
        window.firebaseApp = initializeApp(firebaseConfig);
        window.firebaseAuth = getAuth(window.firebaseApp);
        window.firebaseDb = getFirestore(window.firebaseApp);

        async function authenticateFirebase() {
          try {
            const token = ${JSON.stringify(initialAuthToken)};
            if (token && token !== 'undefined') {
              await signInWithCustomToken(window.firebaseAuth, token);
              console.log('Firebase: Client-side signed in with custom token.');
            } else {
              await signInAnonymously(window.firebaseAuth);
              console.log('Firebase: Client-side signed in anonymously.');
            }
          } catch (error) {
            console.error('Firebase client-side authentication error:', error);
          }
        }
        authenticateFirebase();
      </script>
    </head>
    <body class="p-6">
      <script>
        window.appIdFromBackend = ${JSON.stringify(currentAppId)};
      </script>
      <div id="root" className="container mx-auto p-6 bg-blue-200 rounded-lg shadow-xl mt-10"></div>
      <script type="text/babel">
        const { useState, useEffect } = React;
        const { createRoot } = ReactDOM;

        function App() {
          const [geminiApiKey, setGeminiApiKey] = useState('');
          const [tmdbApiKey, setTmdbApiKey] = useState('');
          const [rpdbApiKey, setRpdbApiKey] = useState('');
          const [addonUrl, setAddonUrl] = useState('');
          const [message, setMessage] = useState('');
          const [error, setError] = useState('');

          const appId = window.appIdFromBackend;

          useEffect(() => {
            console.log('App useEffect hook running.');
            const params = new URLSearchParams(window.location.search);
            if (params.get('error')) {
              setError('An error occurred: ' + params.get('error') + '. Details: ' + (params.get('details') || 'No additional details.'));
              window.history.replaceState({}, document.title, window.location.pathname);
            }

            const fetchInitialKeys = async () => {
              console.log('Attempting to fetch initial GLOBAL API keys from backend.');
              try {
                const response = await fetch('/get-config');
                if (response.ok) {
                  const data = await response.json();
                  setGeminiApiKey(data.geminiApiKey || '');
                  setTmdbApiKey(data.tmdbApiKey || '');
                  setRpdbApiKey(data.rpdbApiKey || '');
                  console.log('Initial GLOBAL API keys fetched and set:', data);
                } else {
                  console.error('Failed to fetch initial configuration:', await response.text());
                  setError('Could not load previously saved keys. Please enter them manually.');
                }
              } catch (err) {
                console.error('Network error fetching initial configuration:', err);
                setError('Network error while trying to load saved keys. Check your connection.');
              }
            };
            fetchInitialKeys();
          }, []);

          const handleSaveKeys = async () => {
            if (!geminiApiKey || !tmdbApiKey) {
              setError('Google Gemini API Key and TMDB API Key are required fields.');
              return;
            }
            setError('');
            setMessage('Saving API keys...');
            try {
              const response = await fetch('/save-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ geminiApiKey, tmdbApiKey, rpdbApiKey })
              });
              const data = await response.json();
              if (response.ok && data.success) {
                setMessage('API keys saved successfully! You can now install the addon.');
                setAddonUrl(`${getBaseUrl()}/manifest.json`);
              } else {
                setError('Failed to save API keys: ' + (data.error || 'Unknown error.'));
              }
            } catch (err) {
              setError('Network error while saving keys: ' + err.message);
            }
          };

          const handleCopyUrl = () => {
            const urlToCopy = addonUrl || `${getBaseUrl()}/manifest.json`;
            const textarea = document.createElement('textarea');
            textarea.value = urlToCopy;
            textarea.style.position = 'absolute';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            textarea.select();
            try {
              document.execCommand('copy');
              setMessage('Addon URL copied to clipboard!');
            } catch (err) {
              setError('Failed to copy URL. Please copy it manually.');
              console.error('Failed to copy text:', err);
            } finally {
              document.body.removeChild(textarea);
            }
          };

          function getBaseUrl() {
            const protocol = window.location.protocol;
            const host = window.location.host;
            return `${protocol}//${host}`;
          }

          return (
            <div className="flex flex-col items-center p-8 space-y-6">
              <h1 className="text-4xl font-bold text-blue-800 mb-6 text-center">Stremio Gemini AI Addon</h1>
              <h2 className="text-2xl font-semibold text-blue-700 mb-4 text-center">(Instance ID: {appId.substring(0, 8)})</h2>
              <p className="text-lg text-blue-900 text-center mb-4">
                This addon leverages Google Gemini AI for personalized movie and series recommendations and enhanced search.
                This version does NOT integrate with Trakt.tv.
              </p>
              <div className="w-full max-w-md bg-blue-100 p-6 rounded-lg shadow-md space-y-4 border border-blue-300">
                <h2 className="text-2xl font-semibold text-blue-800 mb-4">API Key Configuration</h2>
                <p className="text-blue-700 text-sm">
                  Input your API keys below. These keys will be saved persistently in Firestore.
                </p>
                <div>
                  <label htmlFor="geminiApiKey" className="block text-blue-900 text-sm font-bold mb-2 mt-4">
                    Google Gemini API Key:
                  </label>
                  <input
                    type="password"
                    id="geminiApiKey"
                    className="shadow appearance-none border rounded w-full py-2 px-3 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500"
                    value={geminiApiKey}
                    onChange={(e) => setGeminiApiKey(e.target.value)}
                    placeholder="Enter your Google Gemini API Key"
                  />
                </div>
                <div>
                  <label htmlFor="tmdbApiKey" className="block text-blue-900 text-sm font-bold mb-2 mt-4">
                    TMDB API Key:
                  </label>
                  <input
                    type="text"
                    id="tmdbApiKey"
                    className="shadow appearance-none border rounded w-full py-2 px-3 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500"
                    value={tmdbApiKey}
                    onChange={(e) => setTmdbApiKey(e.target.value)}
                    placeholder="Enter your TMDB API Key"
                  />
                </div>
                <div>
                  <label htmlFor="rpdbApiKey" className="block text-blue-900 text-sm font-bold mb-2 mt-4">
                    RPDB API Key (Optional):
                  </label>
                  <input
                    type="password"
                    id="rpdbApiKey"
                    className="shadow appearance-none border rounded w-full py-2 px-3 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500"
                    value={rpdbApiKey}
                    onChange={(e) => setRpdbApiKey(e.target.value)}
                    placeholder="Enter your RPDB API Key (optional)"
                  />
                </div>
                <button
                  onClick={handleSaveKeys}
                  className="w-full py-2 px-4 rounded-md font-semibold shadow-lg transition duration-300 ease-in-out transform hover:scale-105"
                >
                  Save All API Keys
                </button>
                <p className="text-sm text-blue-700 mt-2">
                  After saving, keys are stored persistently. Re-save if redeploying to a new instance.
                </p>
              </div>
              {message && (
                <div className="message-box success">
                  {message}
                </div>
              )}
              {error && (
                <div className="message-box error">
                  {error}
                </div>
              )}
              <div className="w-full max-w-md bg-blue-100 p-6 rounded-lg shadow-md space-y-4 border border-blue-300">
                <h2 className="text-2xl font-semibold text-blue-800 mb-4">Install in Stremio</h2>
                <p className="text-blue-700 break-words">
                  Copy this URL and paste it into Stremio's addon search bar:
                  <br />
                  <code className="bg-blue-300 p-2 rounded block mt-2 text-blue-900 select-all cursor-pointer"
                        onClick={handleCopyUrl}>
                    {addonUrl || `${getBaseUrl()}/manifest.json`}
                  </code>
                </p>
                <button
                  onClick={handleCopyUrl}
                  className="w-full py-2 px-4 rounded-md font-semibold shadow-lg transition duration-300 ease-in-out transform hover:scale-105"
                >
                  Copy Addon URL
                </button>
                <p className="text-sm text-blue-700 mt-2">
                  After installing, look for "Gemini Movie Recs" and "Gemini Series Recs" in Stremio.
                </p>
              </div>
              <p className="text-sm text-blue-600 mt-6 text-center">
                Powered by Google Gemini AI
              </p>
            </div>
          );
        }

        document.addEventListener('DOMContentLoaded', () => {
          const container = document.getElementById('root');
          if (container) {
            try {
              const root = createRoot(container);
              console.log('Rendering React app.');
              root.render(<App />);
            } catch (renderError) {
              console.error('Error rendering React app:', renderError);
              container.innerHTML = `<div style="color: red; text-align: center; padding: 20px; background-color: #ffe0b2; border-radius: 0.5rem; border: 1px solid #ff9800;">
                <h1 style="color: #d32f2f;">An error occurred loading the configuration page.</h1>
                <p style="color: #424242;">Please check the browser's developer console (F12) for details.</p>
              </div>`;
            }
          } else {
            console.error('Root element not found.');
          }
        });
      </script>
    </body>
    </html>
  `;

  res.send(htmlContent);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}).on('error', (error) => {
  console.error('Server startup error:', error.message, error.stack);
});
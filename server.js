// server.js
// This file serves as both the Node.js Express backend for the Stremio Addon
// and hosts the React-based configuration frontend.

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
// Note: GoogleGenerativeAI will be initialized dynamically in the catalog handler
// using the user-configured API key, not globally here.
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');
const crypto = require('crypto'); // Used for generating unique states, still useful for other OAuth if needed later

// --- Firebase Admin SDK Imports and Initialization ---
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

// Global variables provided by the Canvas environment for Firebase configuration
const firebaseConfig = JSON.parse(process.env.__firebase_config || '{}');
// Use __app_id for unique collection paths in Firestore and for unique Stremio addon ID.
const appId = process.env.__app_id || 'default-addon-id-for-dev';

// Initialize Firebase Admin SDK (must be done only once on server startup)
let db;
try {
    if (Object.keys(firebaseConfig).length > 0 && firebaseConfig.projectId) {
        admin.initializeApp({
            credential: admin.credential.cert(firebaseConfig)
        });
        db = getFirestore();
        console.log("Firebase Admin SDK initialized successfully.");
    } else {
        console.warn("Firebase Admin SDK not initialized: Missing or invalid __firebase_config. Firestore operations will be skipped.");
    }
} catch (error) {
    console.error("Firebase Admin SDK initialization failed:", error);
}

// --- Global API Key Storage (will be populated from Firestore and used dynamically) ---
// These keys will be loaded from Firestore (or ENV as fallback) and used by the addon's core logic.
let currentApiKeys = {
    geminiApiKey: process.env.GEMINI_API_KEY || null,
    tmdbApiKey: process.env.TMDB_API_KEY || null,
    rpdbApiKey: process.env.RPDB_API_KEY || null,
};

// Define a consistent "user ID" for storing the addon's GLOBAL configuration in Firestore.
const ADDON_CONFIG_FIRESTORE_USER_ID = 'global_addon_config';

/**
 * Fetches GLOBAL API keys from Firestore and updates the in-memory `currentApiKeys`.
 * Fallback to environment variables if Firestore is unavailable or keys not found.
 */
async function loadApiKeysFromFirestore() {
    if (!db) {
        console.warn("Firestore instance not available. Cannot load global API keys from Firestore. Using environment variables.");
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
            console.log("Global API keys loaded from Firestore.");
        } else {
            console.log("No global API keys found in Firestore for this addon instance. Using environment variables as fallback.");
        }
    } catch (error) {
        console.error("Error loading global API keys from Firestore:", error);
        console.warn("Falling back to environment variables for API keys.");
    }
}

// Call this function at server startup to load keys
loadApiKeysFromFirestore();

// --- Express App Setup ---
const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes, essential for Stremio to access the addon.
app.use(cors());
// Parse JSON request bodies
app.use(bodyParser.json());

// Helper function to dynamically get the base URL of the deployed application
function getBaseUrl(req) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    return `${protocol}://${host}`;
}

// --- Stremio Addon Endpoints ---

// Redirect root path to the /configure page
app.get('/', (req, res) => {
    res.redirect('/configure');
});

/**
 * Serves the Stremio Addon manifest file.
 * This file describes the addon's capabilities to Stremio.
 * Stremio clients will fetch this at /manifest.json.
 *
 * The `id` is dynamically set using `appId` for uniqueness.
 * `dontAnnounce` is set to `false` for discoverability.
 */
app.get('/manifest.json', (req, res) => {
    const manifest = {
        "id": `com.gemini.stremio.recommender.${appId}`, // Unique ID for your addon instance
        "version": "1.0.0",
        "name": `Gemini AI Addon (${appId.substring(0, 8)})`, // Display name with unique identifier
        "description": "Stremio addon powered by Google Gemini AI for personalized movie/series recommendations and enhanced search.",
        "logo": `https://placehold.co/120x120/ADD8E6/00008B?text=AI+Addon`, // Light blue/Dark blue logo
        "background": `https://placehold.co/1000x500/ADD8E6/00008B?text=Stremio+AI+Addon`, // Light blue/Dark blue background
        "resources": [
            "catalog",
            "meta"
        ],
        "types": [
            "movie",
            "series"
        ],
        "idProperty": "imdb_id",
        "catalogs": [
            {
                "type": "movie",
                "id": "gemini_movie_recommendations",
                "name": "Gemini Movie Recs",
                "extraRequired": ["search"],
                "extraSupported": ["search"] // No 'user' parameter anymore
            },
            {
                "type": "series",
                "id": "gemini_series_recommendations",
                "name": "Gemini Series Recs",
                "extraRequired": ["search"],
                "extraSupported": ["search"] // No 'user' parameter anymore
            }
        ],
        "dontAnnounce": false, // Set to false to allow discovery on addons.strem.io
        "config": []
    };
    res.json(manifest);
});

/**
 * Handles requests for content catalogs (lists of movies/series).
 * It dynamically initializes GoogleGenerativeAI with the `geminiApiKey`.
 */
app.get('/catalog/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    const { search, extra } = req.query;

    console.log(`Catalog request: Type=${type}, Catalog ID=${id}, Search Query=${search || 'N/A'}`);

    // Ensure API keys are loaded for the latest configuration
    await loadApiKeysFromFirestore();

    // Construct a config object to pass to addon.js, containing only necessary keys
    const configData = {
        GeminiApiKey: currentApiKeys.geminiApiKey,
        TmdbApiKey: currentApiKeys.tmdbApiKey,
        RpdbApiKey: currentApiKeys.rpdbApiKey,
        // No Trakt keys are passed
    };

    // Check for essential API keys before calling addon.js logic
    if (!configData.GeminiApiKey || !configData.TmdbApiKey) {
        console.error("Missing critical API keys (Gemini or TMDB) for catalog generation.");
        return res.json({ metas: [{
            id: `tt_missing_keys`,
            type: type,
            name: `Configuration Required`,
            poster: `https://placehold.co/200x300/DC143C/FFFFFF?text=MISSING+KEYS`,
            posterShape: "regular",
            description: "Please visit the addon's configuration page to enter and save your API keys (Gemini, TMDB).",
            genres: ["Error", "Configuration"]
        }] });
    }

    try {
        // Pass the configData to the addon.js catalogHandler.
        // The addon.js will handle AI calls and metadata fetching using these keys.
        // We simulate the stremioConfig structure for consistency with addon.js.
        const { metas, error } = await require('./addon').catalogHandler({ type, extra, search }, { stremioConfig: JSON.stringify(configData) });

        if (error) {
            console.error("Error from addon.js catalogHandler:", error);
            return res.status(500).json({ metas: [], error: error });
        }
        res.json({ metas: metas });
    } catch (handlerError) {
        console.error("Unhandled error in catalogHandler:", handlerError);
        res.status(500).json({ metas: [], error: "An unexpected error occurred in the addon logic." });
    }
});

/**
 * Handles requests for detailed metadata about a specific item (movie/series).
 * This endpoint provides mock data as the addon.js `toStremioMeta` is used within catalog.
 */
app.get('/meta/:type/:imdb_id.json', async (req, res) => {
    const { type, imdb_id } = req.params;
    console.log(`Meta request: Type=${type}, IMDb ID=${imdb_id}`);

    const mockMeta = {
        id: imdb_id,
        type: type,
        name: `Dynamic ${type === 'movie' ? 'Film' : 'Show'} - ${imdb_id}`,
        // Placeholder images.
        poster: `https://placehold.co/200x300/6495ED/00008B?text=Poster`, // Light blue/Dark blue
        background: `https://placehold.co/1000x500/6495ED/00008B?text=Background`,
        description: `This is a detailed description for the item with ID ${imdb_id}. ` +
                     `The Stremio AI Addon uses AI for recommendations and search, and relies on TMDB for metadata.`,
        releaseInfo: "2024",
        genres: ["AI-Generated Pick", "Futuristic", "Interactive", "Drama"],
        director: ["AI Visionary"],
        cast: ["Digital Actor 1", "Digital Actor 2", "Virtual Persona 3"],
        imdbRating: "8.5",
        runtime: "150 min",
        trailer: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    };

    res.json({ meta: mockMeta });
});

/**
 * Endpoint to save GLOBAL API keys to Firestore from the frontend.
 * These keys will then be used by the addon's logic and persist across server restarts.
 */
app.post('/save-config', async (req, res) => {
    const { geminiApiKey, tmdbApiKey, rpdbApiKey } = req.body; // Only these keys are expected now

    if (!db) {
        return res.status(500).json({ error: "Firestore is not initialized. Cannot save API keys persistently." });
    }
    if (!geminiApiKey || !tmdbApiKey) {
        return res.status(400).json({ error: "Gemini API Key and TMDB API Key are required." });
    }

    try {
        const configDocRef = db.collection('artifacts').doc(appId)
                                .collection('users').doc(ADDON_CONFIG_FIRESTORE_USER_ID)
                                .collection('addon_config').doc('api_keys');
        await configDocRef.set({
            geminiApiKey,
            tmdbApiKey,
            rpdbApiKey: rpdbApiKey || null, // RPDB key is optional
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // Update in-memory keys for immediate use in this running instance
        currentApiKeys.geminiApiKey = geminiApiKey;
        currentApiKeys.tmdbApiKey = tmdbApiKey;
        currentApiKeys.rpdbApiKey = rpdbApiKey;

        console.log("Global API keys saved to Firestore and updated in-memory.");
        res.json({ success: true, message: "API keys saved successfully!" });
    } catch (error) {
        console.error("Error saving global API keys to Firestore:", error);
        res.status(500).json({ error: "Failed to save API keys." });
    }
});

/**
 * Endpoint to retrieve GLOBAL API keys from Firestore for the frontend.
 */
app.get('/get-config', async (req, res) => {
    if (!db) {
        console.warn("Firestore instance not available for /get-config. Returning empty config.");
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
            console.log("Global configuration data sent to frontend.");
        } else {
            res.json({});
            console.log("No global configuration data found for frontend.");
        }
    } catch (error) {
        console.error("Error retrieving global API keys from Firestore for frontend:", error);
        res.status(500).json({ error: "Failed to retrieve configuration." });
    }
});


// REMOVED: /trakt-auth-initiate and /trakt-callback endpoints
// REMOVED: refreshTraktToken function

// --- Web Configuration Frontend (React embedded directly in HTML) ---
app.get('/configure', (req, res) => {
    // These variables are provided by the Canvas environment.
    const firebaseConfigJson = typeof process.env.__firebase_config !== 'undefined' ? JSON.stringify(JSON.parse(process.env.__firebase_config)) : '{}';
    const initialAuthToken = typeof process.env.__initial_auth_token !== 'undefined' ? `'${process.env.__initial_auth_token}'` : 'undefined';
    const currentAppId = process.env.__app_id || 'default-addon-id'; // Pass appId to frontend

    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Stremio Gemini Addon Configuration</title>
            <!-- Load React and ReactDOM from CDN -->
            <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
            <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
            <!-- Load Babel for JSX transformation in the browser -->
            <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
            <!-- Load Tailwind CSS from CDN -->
            <script src="https://cdn.tailwindcss.com"></script>
            <!-- Load Inter font from Google Fonts -->
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
            <style>
                /* Custom styles for the configuration page, enhancing Tailwind defaults */
                body {
                    font-family: 'Inter', sans-serif;
                    background-color: #E3F2FD; /* Light Blue */
                    color: #1A237E; /* Dark Blue */
                }
                .container {
                    max-width: 800px;
                }
                /* Styling for input fields */
                input[type="text"], input[type="password"] {
                    background-color: #BBDEFB; /* Lighter Blue */
                    border: 1px solid #64B5F6; /* Medium Blue */
                    color: #1A237E;
                    padding: 0.5rem 0.75rem;
                    border-radius: 0.375rem; /* rounded-md */
                    width: 100%;
                    transition: all 0.2s ease-in-out;
                }
                input[type="text"]:focus, input[type="password"]:focus {
                    outline: none;
                    box-shadow: 0 0 0 2px rgba(33, 150, 243, 0.5); /* Blue 500 ring */
                }
                /* Styling for buttons */
                button {
                    background-color: #1976D2; /* Blue 700 */
                    color: white;
                    padding: 0.625rem 1rem;
                    border-radius: 0.375rem; /* rounded-md */
                    font-weight: 600; /* font-semibold */
                    transition: all 0.3s ease-in-out;
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); /* shadow-lg */
                }
                button:hover {
                    background-color: #1565C0; /* Blue 800 */
                    transform: scale(1.02);
                }
                /* Styling for message boxes (success, error, info) */
                .message-box {
                    padding: 1rem;
                    border-radius: 0.5rem;
                    width: 100%;
                    max-width: 40rem; /* Max width for consistency */
                    text-align: center;
                    font-weight: 500;
                }
                .success {
                    background-color: #4CAF50; /* Green */
                    color: white;
                }
                .error {
                    background-color: #F44336; /* Red */
                    color: white;
                }
                .info {
                    background-color: #2196F3; /* Blue */
                    color: white;
                }
            </style>
            <!-- Firebase SDKs for client-side functionality -->
            <script type="module">
                // Import necessary Firebase modules from CDN
                import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
                import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
                import { getFirestore, doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

                // Initialize Firebase App with config provided by the environment
                const firebaseConfig = ${firebaseConfigJson};
                window.firebaseApp = initializeApp(firebaseConfig);
                window.firebaseAuth = getAuth(window.firebaseApp);
                window.firebaseDb = getFirestore(window.firebaseApp);

                // Authenticate Firebase user for client-side functionality
                async function authenticateFirebase() {
                    try {
                        const token = ${initialAuthToken};
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

                onAuthStateChanged(window.firebaseAuth, (user) => {
                    if (user) {
                        window.currentClientSideFirebaseUserId = user.uid; // Make client-side Firebase user ID available globally
                        console.log('Firebase: Current client-side User ID:', window.currentClientSideFirebaseUserId);
                    } else {
                        window.currentClientSideFirebaseUserId = null;
                        console.log('Firebase: No client-side user signed in.');
                    }
                });
            </script>
        </head>
        <body class="p-6">
            <!-- Global JS variable for appId to be used by React component -->
            <script>
                window.appIdFromBackend = '${currentAppId}'; // This is where appId is correctly injected
            </script>
            <div id="root" class="container mx-auto p-6 bg-blue-200 rounded-lg shadow-xl mt-10"></div>

            <script type="text/babel">
                const { useState, useEffect } = React;
                const { createRoot } = ReactDOM;

                function App() {
                    console.log("App component started rendering.");
                    // State variables for API keys and messages
                    const [geminiApiKey, setGeminiApiKey] = useState('');
                    const [tmdbApiKey, setTmdbApiKey] = useState('');
                    const [rpdbApiKey, setRpdbApiKey] = useState('');
                    const [addonUrl, setAddonUrl] = useState('');
                    const [message, setMessage] = useState('');
                    const [error, setError] = useState('');

                    // Get the unique app ID from the global variable (safely injected)
                    const appId = window.appIdFromBackend; // Corrected access

                    // Effect hook to run once on component mount for initial setup and URL parameter parsing
                    useEffect(() => {
                        console.log("App useEffect hook running.");

                        // Parse URL parameters for messages (e.g., from failed redirects)
                        const params = new URLSearchParams(window.location.search);
                        if (params.get('error')) {
                            setError('An error occurred: ' + params.get('error') + '. Details: ' + (params.get('details') || 'No additional details.'));
                            window.history.replaceState({}, document.title, window.location.pathname);
                        }

                        // Fetch initial GLOBAL API keys from backend (stored persistently for this addon instance)
                        const fetchInitialKeys = async () => {
                            console.log("Attempting to fetch initial GLOBAL API keys from backend.");
                            try {
                                const response = await fetch('/get-config');
                                if (response.ok) {
                                    const data = await response.json();
                                    setGeminiApiKey(data.geminiApiKey || '');
                                    setTmdbApiKey(data.tmdbApiKey || '');
                                    setRpdbApiKey(data.rpdbApiKey || '');
                                    console.log("Initial GLOBAL API keys fetched and set:", data);
                                } else {
                                    console.error("Failed to fetch initial configuration from backend:", await response.text());
                                    setError("Could not load previously saved keys. Please enter them manually.");
                                }
                            } catch (err) {
                                console.error("Network error fetching initial configuration:", err);
                                setError("Network error while trying to load saved keys. Check your connection.");
                            }
                        };
                        fetchInitialKeys();
                    }, []); // Empty dependency array ensures this runs only once on mount

                    // Handler for saving all API keys to the backend (which persists them to Firestore)
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
                                setMessage('API keys saved successfully for this addon instance! You can now install the addon.');
                                // Update the addon URL to reflect the new state (no user ID needed now)
                                setAddonUrl(`${getBaseUrl()}/manifest.json`);
                            } else {
                                setError('Failed to save API keys: ' + (data.error || 'Unknown error.'));
                            }
                        } catch (err) {
                            setError('Network error while saving keys: ' + err.message);
                        }
                    };

                    // Handler for copying the addon URL to clipboard
                    const handleCopyUrl = () => {
                        const urlToCopy = addonUrl || `${getBaseUrl()}/manifest.json`; // Use current addonUrl state or default
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
                            setError('Failed to copy URL. Please copy it manually from the text field.');
                            console.error('Failed to copy text:', err);
                        } finally {
                            document.body.removeChild(textarea);
                        }
                    };

                    // Helper to get base URL for display
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
                                    Input your API keys below. These keys will be saved persistently for this specific addon instance in Firestore.
                                </p>

                                {/* Input field for Gemini API Key */}
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
                                {/* Input field for TMDB API Key */}
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
                                {/* Input field for RPDB API Key */}
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
                                {/* Button to save all API keys */}
                                <button
                                    onClick={handleSaveKeys}
                                    className="w-full py-2 px-4 rounded-md font-semibold shadow-lg transition duration-300 ease-in-out transform hover:scale-105"
                                >
                                    Save All API Keys
                                </button>
                                <p className="text-sm text-blue-700 mt-2">
                                    After saving, these keys will be stored persistently for this addon instance.
                                    You will need to re-save if you redeploy the addon to a *new* Render instance,
                                    as each instance has a unique ID and separate Firestore storage.
                                </p>
                            </div>

                            {/* Conditional rendering for success and error messages */}
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

                            {/* Install in Stremio section */}
                            <div className="w-full max-w-md bg-blue-100 p-6 rounded-lg shadow-md space-y-4 border border-blue-300">
                                <h2 className="text-2xl font-semibold text-blue-800 mb-4">Install in Stremio</h2>
                                <p className="text-blue-700 break-words">
                                    Copy this URL and paste it into Stremio's addon search bar (click the puzzle piece icon, then "Addon search"):
                                    <br />
                                    <code className="bg-blue-300 p-2 rounded block mt-2 text-blue-900 select-all cursor-pointer"
                                          onClick={handleCopyUrl}>
                                        {displayAddonUrl}
                                    </code>
                                </p>
                                {/* Button to copy the URL */}
                                <button
                                    onClick={handleCopyUrl}
                                    className="w-full py-2 px-4 rounded-md font-semibold shadow-lg transition duration-300 ease-in-out transform hover:scale-105"
                                >
                                    Copy Addon URL
                                </button>
                                <p className="text-sm text-blue-700 mt-2">
                                    After installing, look for "Gemini Movie Recs" and "Gemini Series Recs" in your Stremio Discover section.
                                    Remember, this addon provides recommendations and enhanced search results, but it does not provide actual streaming links.
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
                            console.log("Attempting to render React app to #root element.");
                            root.render(<App />);
                        } catch (renderError) {
                            console.error("Error during React app rendering:", renderError);
                            container.innerHTML = `<div style="color: red; text-align: center; padding: 20px; background-color: #ffe0b2; border-radius: 0.5rem; border: 1px solid #ff9800;">
                                <h1 style="color: #d32f2f;">An error occurred loading the configuration page.</h1>
                                <p style="color: #424242;">Please check the browser's developer console (F12) for more details. Look for JavaScript errors.</p>
                                <p style="color: #424242;">This might be due to a problem with the embedded React app or its dependencies.</p>
                            </div>`;
                        }
                    } else {
                        console.error("Error: Root element not found! Cannot render React app.");
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// --- Start the Express Server ---
app.listen(PORT, () => {
    console.log(`Stremio Gemini Addon server running on port ${PORT}`);
    console.log(`Access configuration at http://localhost:${PORT}/configure`);
    console.log(`Addon manifest at http://localhost:${PORT}/manifest.json`);
});

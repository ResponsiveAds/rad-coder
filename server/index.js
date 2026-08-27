const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const TUI = require('./tui');
const { ansi } = require('./tui');
const sync = require('./sync');

// ============================================================
// TUI Instance & Logging
// ============================================================

let tui = null;

/**
 * Log a message — routes to TUI scroll area when active, otherwise console.log
 */
function log(message) {
  if (tui && !tui.destroyed) {
    tui.log(message);
  } else {
    console.log(message);
  }
}

/**
 * Open the user's code editor
 */
function openEditor() {
  const editorCmd = process.env.RAD_CODER_EDITOR
    || process.env.VISUAL
    || process.env.EDITOR
    || 'code';

  try {
    const child = spawn(editorCmd, [userDir], {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32'
    });
    child.unref();
    child.on('error', (err) => {
      log(` ✗ Could not open editor "${editorCmd}": ${err.message}`);
    });
    log(` Editor (${editorCmd}) opened`);
  } catch (err) {
    log(` ✗ Could not open editor "${editorCmd}": ${err.message}`);
  }
}

// ============================================================
// Directory Configuration
// ============================================================

// When run via npx, these are set by bin/cli.js
// When run directly for development, use defaults
const userDir = process.env.RAD_CODER_USER_DIR || process.cwd();
const packageDir = process.env.RAD_CODER_PACKAGE_DIR || path.join(__dirname, '..');
const noUiMode = process.env.RAD_CODER_NO_UI === '1';
const noBrowserMode = process.env.RAD_CODER_NO_BROWSER === '1';

// ============================================================
// CLI Argument Parsing
// ============================================================

// Check if we're being required as a module (from cli.js) or run directly
const isModule = require.main !== module;

let creativeId = null;

if (!isModule) {
  const input = process.argv[2];

  if (!input) {
    console.error('\n Usage: npx rad-coder <creativeId or previewUrl>\n');
    console.error(' Examples:');
    console.error('   npx rad-coder 697b80fcc6e904025f5147a0');
    console.error('   npx rad-coder https://studio.responsiveads.com/creatives/697b80fcc6e904025f5147a0/preview\n');
    process.exit(1);
  }

  /**
   * Extract creative ID from URL or use directly
   */
  function extractCreativeIdLocal(input) {
    // If it's a URL, extract the ID
    const urlMatch = input.match(/creatives\/([a-f0-9]+)/i);
    return urlMatch ? urlMatch[1] : input;
  }

  creativeId = extractCreativeIdLocal(input);
}

// ============================================================
// Fetch Creative Config from Studio Preview Page
// ============================================================

let creativeConfig = null;

/**
 * Extract a JSON object from HTML using balanced bracket parsing
 * @param {string} html - The HTML content
 * @param {string} startMarker - The marker to find (e.g., 'window.creative = ')
 * @returns {object|null} - Parsed JSON object or null
 */
function extractJsonObject(html, startMarker) {
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) return null;
  
  const jsonStart = startIdx + startMarker.length;
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;
  let endIdx = jsonStart;
  
  for (let i = jsonStart; i < html.length; i++) {
    const char = html[i];
    
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    
    if (char === '"' && !inString) {
      inString = true;
    } else if (char === '"' && inString) {
      inString = false;
    }
    
    if (!inString) {
      if (char === '{') braceCount++;
      if (char === '}') braceCount--;
      
      if (braceCount === 0 && char === '}') {
        endIdx = i + 1;
        break;
      }
    }
  }
  
  try {
    const jsonStr = html.substring(jsonStart, endIdx);
    return JSON.parse(jsonStr);
  } catch (err) {
    return null;
  }
}

function previewUrlFor(creativeId) {
  return `https://studio.responsiveads.com/creatives/${creativeId}/preview`;
}

/**
 * Pull the creative's custom JS out of the preview page HTML
 * @returns {string|null}
 */
function extractCustomJs(html) {
  const creativeObj = extractJsonObject(html, 'window.creative = ');
  if (creativeObj && creativeObj.config && creativeObj.config.customjs) {
    return creativeObj.config.customjs;
  }
  return null;
}

/**
 * Re-read just the custom JS from Studio. Unlike fetchCreativeConfig this never
 * exits the process — it runs on a timer while the dev server is up, so a
 * transient network blip must not kill a working session.
 *
 * @returns {Promise<{ok: boolean, customjs: ?string, error: ?string}>}
 */
async function fetchRemoteCustomJs(creativeId) {
  // Dev/testing seam: we cannot write to Studio, so allow faking its response.
  const fakePath = process.env.RAD_CODER_FAKE_REMOTE_JS;
  if (fakePath) {
    try {
      return { ok: true, customjs: fs.readFileSync(fakePath, 'utf-8'), error: null };
    } catch (err) {
      return { ok: false, customjs: null, error: `fake remote unreadable: ${err.message}` };
    }
  }

  try {
    const response = await fetch(previewUrlFor(creativeId), { cache: 'no-store' });
    if (!response.ok) {
      return { ok: false, customjs: null, error: `HTTP ${response.status}: ${response.statusText}` };
    }
    const html = await response.text();
    return { ok: true, customjs: extractCustomJs(html), error: null };
  } catch (err) {
    return { ok: false, customjs: null, error: err.message };
  }
}

/**
 * Fetch and parse creative configuration from studio preview page
 */
async function fetchCreativeConfig(creativeId) {
  const previewUrl = previewUrlFor(creativeId);

  log(` Fetching creative config from studio...`);
  log(` URL: ${previewUrl}\n`);
  
  try {
    const response = await fetch(previewUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const html = await response.text();
    
    // Extract window.creativeId
    const creativeIdMatch = html.match(/window\.creativeId\s*=\s*['"]([^'"]+)['"]/);
    const extractedCreativeId = creativeIdMatch ? creativeIdMatch[1] : creativeId;
    
    // Extract window.creative object to get customjs
    let customjs = extractCustomJs(html);

    // Dev/testing seam — see fetchRemoteCustomJs
    if (process.env.RAD_CODER_FAKE_REMOTE_JS) {
      const faked = await fetchRemoteCustomJs(creativeId);
      if (faked.ok) customjs = faked.customjs;
    }

    // Extract flowlines - try multiple patterns
    let flowlines;
    
    // First try: Look for flowlinesString variable (cleaner JSON)
    const flowlinesStringMatch = html.match(/var\s+flowlinesString\s*=\s*\('(\[[\s\S]*?\])'\)/);
    if (flowlinesStringMatch) {
      try {
        // The string has escaped single quotes, replace them
        const jsonStr = flowlinesStringMatch[1].replace(/\\'/g, "'");
        flowlines = JSON.parse(jsonStr);
      } catch (parseErr) {
        // Continue to next method
      }
    }
    
    // Second try: Look for window.flowlines = JSON.parse(flowlinesString)
    // In this case, extract from the initial assignment
    if (!flowlines) {
      const flowlinesMatch = html.match(/window\.flowlines\s*=\s*(\[[\s\S]*?\]);[\s\n]/);
      if (flowlinesMatch) {
        try {
          // Try to clean up escaped quotes
          let jsonStr = flowlinesMatch[1];
          jsonStr = jsonStr.replace(/\\'/g, "'");
          flowlines = JSON.parse(jsonStr);
        } catch (parseErr) {
          // Continue to next method
        }
      }
    }
    
    // Third try: Use a more robust extraction by finding balanced brackets
    if (!flowlines) {
      const startMarker = 'window.flowlines = [';
      const startIdx = html.indexOf(startMarker);
      if (startIdx !== -1) {
        let bracketCount = 0;
        let inString = false;
        let escapeNext = false;
        let endIdx = startIdx + startMarker.length - 1;
        
        for (let i = startIdx + startMarker.length - 1; i < html.length; i++) {
          const char = html[i];
          
          if (escapeNext) {
            escapeNext = false;
            continue;
          }
          
          if (char === '\\') {
            escapeNext = true;
            continue;
          }
          
          if (char === '"' && !inString) {
            inString = true;
          } else if (char === '"' && inString) {
            inString = false;
          }
          
          if (!inString) {
            if (char === '[') bracketCount++;
            if (char === ']') bracketCount--;
            
            if (bracketCount === 0) {
              endIdx = i + 1;
              break;
            }
          }
        }
        
        try {
          let jsonStr = html.substring(startIdx + startMarker.length - 1, endIdx);
          jsonStr = jsonStr.replace(/\\'/g, "'");
          flowlines = JSON.parse(jsonStr);
        } catch (parseErr) {
          throw new Error(`Failed to parse flowlines JSON: ${parseErr.message}`);
        }
      }
    }
    
    if (!flowlines) {
      throw new Error('Could not find or parse window.flowlines in preview page');
    }
    
    if (!flowlines || flowlines.length === 0) {
      throw new Error('No flowlines found for this creative');
    }
    
    // Select first flowline by default
    const fl = flowlines[0];
    
    // Extract sizes from flowline.flowline.sizes or fluidLayouts
    let sizes = [];
    if (fl.flowline && fl.flowline.sizes) {
      sizes = fl.flowline.sizes;
    } else if (fl.fluidLayouts) {
      sizes = fl.fluidLayouts.map(l => `${l.width}x${l.height}`);
    }
  
    
    const envPort = Number.parseInt(process.env.RAD_CODER_PORT || '', 10);
    const preferredPort = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535
      ? envPort
      : 3000;

    return {
      creativeId: extractedCreativeId,
      flowlineId: fl._id || fl.id,
      flowlineName: fl.name || 'Unknown',
      sizes: sizes,
      isFluid: fl.fullyFluid || false,
      adSource: '//edit.responsiveads.com/ads/',
      flSource: '//edit.responsiveads.com/flowlines/',
      radicalScript: 'https://studio.responsiveads.com/js/libs/radical.min.js',
      server: {
        port: preferredPort,
        host: 'localhost'
      },
      // Store all flowlines for reference
      allFlowlines: flowlines.map(f => ({
        id: f._id || f.id,
        name: f.name,
        sizes: f.flowline?.sizes || [],
        isFluid: f.fullyFluid
      })),
      // Custom JS from the creative (if available)
      customjs: customjs
    };
    
  } catch (error) {
    log(`\n ✗ Failed to fetch creative config: ${error.message}\n`);
    process.exit(1);
  }
}

// ============================================================
// Express Server Setup
// ============================================================

const app = express();
const server = http.createServer({ maxHeaderSize: 65536 }, app);

// Track active HTTP sockets so shutdown can force-close stragglers.
const activeSockets = new Set();
server.on('connection', (socket) => {
  activeSockets.add(socket);
  socket.on('close', () => activeSockets.delete(socket));
});
let isShuttingDown = false;

// WebSocket server for hot-reload
const wss = new WebSocketServer({ server });

// Track connected clients
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  log(' Browser connected for hot-reload');
  
  ws.on('close', () => {
    clients.delete(ws);
    log(' Browser disconnected');
  });
});

// Broadcast reload message to all connected browsers
function broadcastReload() {
  const message = JSON.stringify({ type: 'reload' });
  clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}

// Enable CORS for all origins (needed for cross-origin script loading)
app.use(cors());

function sendTestHtml(res) {
  const localTestHtmlPath = path.join(userDir, 'test.html');
  const packageTestHtmlPath = path.join(packageDir, 'public', 'test.html');
  const testHtmlPath = fs.existsSync(localTestHtmlPath) ? localTestHtmlPath : packageTestHtmlPath;

  // Inject the sync banner server-side rather than shipping it in test.html:
  // every project folder keeps its own copy of test.html, so editing the
  // packaged file would never reach projects that already exist.
  let html;
  try {
    html = fs.readFileSync(testHtmlPath, 'utf-8');
  } catch (err) {
    res.status(500).send(`Could not read test.html: ${err.message}`);
    return;
  }

  const banner = '<script src="/rad-sync-banner.js"></script>';
  html = html.includes('</body>')
    ? html.replace('</body>', `  ${banner}\n</body>`)
    : html + banner;

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(html);
}

// Serve project-local test.html when available so users can customize it per creative
app.get('/', (req, res) => {
  sendTestHtml(res);
});

app.get('/test.html', (req, res) => {
  sendTestHtml(res);
});

// Serve static files from public directory (in package)
app.use(express.static(path.join(packageDir, 'public')));

// Serve the custom JS code as a JSON response (for injection into Radical config)
// Custom JS is in user's directory
app.get('/api/custom-js', (req, res) => {
  const customJsPath = path.join(userDir, 'custom.js');
  
  // Set headers to prevent caching
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  
  if (fs.existsSync(customJsPath)) {
    const code = fs.readFileSync(customJsPath, 'utf-8');
    res.json({ code });
  } else {
    res.json({ code: '// custom.js not found - create custom.js in your current directory' });
  }
});

// Report how the local custom.js compares to the version currently in Studio
app.get('/api/sync-status', (req, res) => {
  res.set({ 'Cache-Control': 'no-store, no-cache, must-revalidate' });
  const status = getSyncStatus();
  res.json({
    state: status.state,
    label: describeSyncState(status.state),
    localHash: status.localHash,
    studioHash: status.remoteHash,
    baseHash: status.baseHash,
    summary: status.summary,
    checkedAt: status.checkedAt,
    changedAt: status.changedAt,
    archivedPath: status.archivedPath,
    error: status.error,
  });
});

// Serve dynamically fetched config as JSON for the test page
app.get('/api/config', (req, res) => {
  if (!creativeConfig) {
    res.status(503).json({ error: 'Config not yet loaded' });
    return;
  }
  res.json(creativeConfig);
});

// Watch for changes in custom.js (in user's directory)
const customJsWatchPath = path.join(userDir, 'custom.js');
const watcher = chokidar.watch(customJsWatchPath, {
  persistent: true,
  ignoreInitial: true
});

watcher.on('change', (changedPath) => {
  log(` File changed: ${path.basename(changedPath)}`);
  log(' Reloading browsers...');
  broadcastReload();

  // If the save just brought us level with Studio, say so — and remember it,
  // so we stop treating the difference as unpushed work.
  if (studioState.customjs !== null && sync.sameCode(sync.readLocal(userDir), studioState.customjs)) {
    sync.writeBase(userDir, studioState.customjs);
    sync.removeRemoteCopy(userDir);
    log(` ${ansi.green}✓ custom.js now matches Studio${ansi.reset}`);
  }
});

watcher.on('error', (error) => {
  log(` Watcher error: ${error.message}`);
});

// ============================================================
// Studio Sync Watch
// ============================================================

// Studio's custom JS can be edited by anyone at any time. Poll for it so a
// session that has been open for hours notices before its local file is pasted
// back over somebody else's work.
const studioState = {
  customjs: null,      // last custom JS observed in Studio
  checkedAt: null,     // ISO timestamp of the last successful check
  error: null,         // last fetch error, if the most recent check failed
  changedAt: null,     // when Studio last changed under us
  archivedPath: null,  // where that version was archived
};
let studioPollTimer = null;
let lastLoggedStudioError = null;

function studioPollInterval() {
  const raw = process.env.RAD_CODER_STUDIO_POLL_MS;
  if (raw === undefined) return 60000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return 60000;
  return parsed; // 0 disables polling
}

/** Current local-vs-Studio state, computed fresh from disk */
function getSyncStatus() {
  const local = sync.readLocal(userDir);
  const status = sync.classify({
    local,
    remote: studioState.customjs,
    base: sync.readBase(userDir),
  });

  return {
    ...status,
    checkedAt: studioState.checkedAt,
    changedAt: studioState.changedAt,
    error: studioState.error,
    archivedPath: studioState.archivedPath
      ? sync.relative(userDir, studioState.archivedPath)
      : null,
    // Always expressed as "what Studio has that local does not"
    summary: status.state === 'in-sync' || status.state === 'no-local'
      ? null
      : sync.diffSummary(local, studioState.customjs),
  };
}

/**
 * Check Studio once. Reports only real changes, so it is quiet by default.
 * @param {boolean} announce - log even when nothing changed (manual check)
 */
async function checkStudio(announce = false) {
  const id = creativeConfig ? creativeConfig.creativeId : creativeId;
  const result = await fetchRemoteCustomJs(id);

  if (!result.ok) {
    studioState.error = result.error;
    // Don't spam an unreachable network — log once per distinct error.
    if (announce || result.error !== lastLoggedStudioError) {
      lastLoggedStudioError = result.error;
      log(` ${ansi.dim}Could not check Studio: ${result.error}${ansi.reset}`);
    }
    return getSyncStatus();
  }

  studioState.error = null;
  lastLoggedStudioError = null;
  studioState.checkedAt = new Date().toISOString();

  const unchanged = sync.sameCode(result.customjs, studioState.customjs);
  studioState.customjs = result.customjs;

  if (unchanged) {
    if (announce) {
      const status = getSyncStatus();
      log(` ${ansi.dim}Studio unchanged (${describeSyncState(status.state)})${ansi.reset}`);
    }
    return getSyncStatus();
  }

  // Studio moved. Keep a copy of the version we are about to stop seeing.
  studioState.changedAt = studioState.checkedAt;
  studioState.archivedPath = sync.archiveRemote(userDir, result.customjs);

  const local = sync.readLocal(userDir);
  if (sync.sameCode(local, result.customjs)) {
    sync.writeBase(userDir, result.customjs);
    sync.removeRemoteCopy(userDir);
    log('');
    log(` ${ansi.green}✓ Studio now matches your local custom.js — in sync${ansi.reset}`);
    log('');
    return getSyncStatus();
  }

  const remoteCopy = sync.writeRemoteCopy(userDir, result.customjs);
  log('');
  log(` ${ansi.yellow}${ansi.bold}⚠ STUDIO CHANGED — someone edited this creative's custom JS${ansi.reset}`);
  log(` ${ansi.yellow}  your local custom.js no longer matches Studio${ansi.reset}`);
  log(` ${ansi.yellow}  Studio vs your local: ${sync.diffSummary(local, result.customjs)}${ansi.reset}`);
  log(` ${ansi.yellow}  Studio version → ${sync.relative(userDir, remoteCopy)}${ansi.reset}`);
  if (studioState.archivedPath) {
    log(` ${ansi.yellow}  archived copy  → ${sync.relative(userDir, studioState.archivedPath)}${ansi.reset}`);
  }
  log(` ${ansi.yellow}  ► Do NOT paste your local file into Studio before diffing the two${ansi.reset}`);
  log('');

  return getSyncStatus();
}

function describeSyncState(state) {
  switch (state) {
    case 'in-sync': return 'local matches Studio';
    case 'local-ahead': return 'local edits not in Studio yet';
    case 'remote-ahead': return 'Studio is newer than local';
    case 'diverged': return 'CONFLICT — both sides changed';
    case 'unknown-divergence': return 'CONFLICT — differ, no sync history';
    case 'no-local': return 'no local custom.js';
    default: return state;
  }
}

function startStudioWatch() {
  // Seed from the config already fetched at startup so the state cli.js just
  // reported is not immediately re-reported here.
  if (studioState.customjs === null && creativeConfig) {
    studioState.customjs = creativeConfig.customjs;
    studioState.checkedAt = new Date().toISOString();
  }

  const interval = studioPollInterval();
  if (interval === 0) {
    log(` ${ansi.dim}Studio change watch disabled (RAD_CODER_STUDIO_POLL_MS=0)${ansi.reset}`);
    return;
  }

  studioPollTimer = setInterval(() => {
    checkStudio(false).catch((err) => {
      log(` ${ansi.dim}Studio check failed: ${err.message}${ansi.reset}`);
    });
  }, interval);
  studioPollTimer.unref();
}

/** Take the Studio version, keeping a backup of what we replace */
function pullFromStudio() {
  if (studioState.customjs === null) {
    log(' Nothing to pull — Studio has no custom JS');
    return;
  }

  const backup = sync.backupLocal(userDir);
  fs.writeFileSync(path.join(userDir, 'custom.js'), studioState.customjs, 'utf-8');
  sync.writeBase(userDir, studioState.customjs);
  sync.removeRemoteCopy(userDir);
  log(` ${ansi.green}↓ Pulled custom.js from Studio${ansi.reset}`);
  if (backup) {
    log(`   Previous version saved to ${sync.relative(userDir, backup)}`);
  }
  broadcastReload();
}

// ============================================================
// Start Server
// ============================================================

function listenOnPort(host, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      cleanup();
      reject(err);
    };

    const onListening = () => {
      const address = server.address();
      cleanup();
      resolve(address && typeof address === 'object' ? address.port : port);
    };

    const cleanup = () => {
      server.off('error', onError);
    };

    server.once('error', onError);
    server.listen(port, host, onListening);
  });
}

async function listenOnAvailablePort(host, preferredPort, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    const candidatePort = preferredPort + i;

    try {
      const boundPort = await listenOnPort(host, candidatePort);
      if (i > 0) {
        console.log(`\n Port ${preferredPort} is in use. Using port ${boundPort} instead.`);
      }
      return boundPort;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Could not find an available port in range ${preferredPort}-${preferredPort + maxAttempts - 1}`);
}

async function start(prefetchedConfig = null) {
  console.log('\n========================================');
  console.log(' RAD Coder - ResponsiveAds Creative Tester');
  console.log('========================================\n');
  
  // Use pre-fetched config if provided, otherwise fetch it
  if (prefetchedConfig) {
    creativeConfig = prefetchedConfig;
  } else {
    creativeConfig = await fetchCreativeConfig(creativeId);
  }
  
  console.log(' Creative Config:');
  console.log(` - Creative ID: ${creativeConfig.creativeId}`);
  console.log(` - Flowline: ${creativeConfig.flowlineName}`);
  console.log(` - Flowline ID: ${creativeConfig.flowlineId}`);
  console.log(` - Sizes: ${creativeConfig.sizes.join(', ')}`);
  console.log(` - Is Fluid: ${creativeConfig.isFluid}`);
  console.log(` - Has CustomJS: ${creativeConfig.customjs ? 'Yes' : 'No'}`);
  
  if (creativeConfig.allFlowlines.length > 1) {
    console.log(`\n Available Flowlines (${creativeConfig.allFlowlines.length}):`);
    creativeConfig.allFlowlines.forEach((fl, i) => {
      const marker = i === 0 ? ' (selected)' : '';
      console.log(`   ${i + 1}. ${fl.name}${marker}`);
    });
  }
  
  const { port, host } = creativeConfig.server;
  const activePort = await listenOnAvailablePort(host, port);
  creativeConfig.server.port = activePort;

  console.log(`\n Server running at: http://${host}:${activePort}`);
  console.log(` Test page: http://${host}:${activePort}/`);
  console.log(`\n Working directory: ${userDir}`);
  console.log(' Edit custom.js and save to hot-reload\n');

  // Small delay to ensure server is fully ready before opening browser
  await new Promise(resolve => setTimeout(resolve, 500));

  // Auto-open browser unless disabled
  if (!noBrowserMode) {
    try {
      const open = (await import('open')).default;
      await open(`http://${host}:${activePort}/`);
      console.log(' Browser opened automatically');
    } catch (err) {
      console.log(` Could not auto-open browser: ${err.message}`);
      console.log(` Please open http://${host}:${activePort}/ manually`);
    }
  } else {
    console.log(' Browser auto-open disabled (--no-ui)');
  }

  // Auto-open editor (unless --no-editor)
  if (!process.env.RAD_CODER_NO_EDITOR) {
    openEditor();
  }

  // Watch Studio for custom JS edits made by other people
  startStudioWatch();

  // Start interactive TUI unless disabled
  if (!noUiMode && process.stdin.isTTY) {
    await new Promise(resolve => setTimeout(resolve, 300));
    startInteractiveMenu();
  } else if (noUiMode) {
    console.log(' Running in no-UI mode');
    console.log(' Press Ctrl+C to stop\n');
  } else {
    console.log(' Press Ctrl+C to stop\n');
  }
}

// ============================================================
// Interactive Menu
// ============================================================

function getMainMenuItems() {
  const items = [
    { label: 'Open Browser', id: 'open-browser' },
    { label: 'Open Editor', id: 'open-editor' },
  ];

  if (creativeConfig && creativeConfig.allFlowlines.length > 1) {
    items.push({ label: 'Switch Flowline', id: 'switch-flowline', description: `(${creativeConfig.flowlineName})` });
  }

  items.push(
    { label: 'Check Studio Now', id: 'sync-check' },
    { label: 'Diff vs Studio', id: 'sync-diff' },
    { label: 'Pull from Studio', id: 'sync-pull' },
    { label: 'Server Status', id: 'status' },
    { label: 'Clear Logs', id: 'clear' },
    { label: 'Restart Server', id: 'restart' },
    { label: 'Stop Server', id: 'stop' },
  );

  return items;
}

function getFlowlineMenuItems() {
  const items = [{ label: '← Back', id: 'back' }];
  creativeConfig.allFlowlines.forEach((fl, i) => {
    const marker = fl.id === creativeConfig.flowlineId ? ' ✓' : '';
    items.push({ label: `${fl.name}${marker}`, id: `flowline-${i}`, flowlineIndex: i });
  });
  return items;
}

function startInteractiveMenu() {
  tui = new TUI();

  let inSubMenu = false;

  function handleSelect(item) {
    // Sub-menu: flowline selection
    if (inSubMenu) {
      if (item.id === 'back') {
        inSubMenu = false;
        tui.updateMenu(getMainMenuItems());
        return;
      }
      // Switch flowline
      const fl = creativeConfig.allFlowlines[item.flowlineIndex];
      if (fl) {
        creativeConfig.flowlineId = fl.id;
        creativeConfig.flowlineName = fl.name;
        creativeConfig.sizes = fl.sizes || [];
        creativeConfig.isFluid = fl.isFluid || false;
        log(` Switched to flowline: ${fl.name}`);
        broadcastReload();
      }
      inSubMenu = false;
      tui.updateMenu(getMainMenuItems());
      return;
    }

    // Main menu actions
    switch (item.id) {
      case 'open-browser': {
        const { port, host } = creativeConfig.server;
        import('open').then(mod => {
          mod.default(`http://${host}:${port}/`);
          log(' Browser opened');
        }).catch(err => {
          log(` Could not open browser: ${err.message}`);
        });
        break;
      }

      case 'open-editor':
        openEditor();
        break;

      case 'switch-flowline':
        inSubMenu = true;
        tui.updateMenu(getFlowlineMenuItems());
        break;

      case 'sync-check':
        log(' Checking Studio for custom JS changes...');
        checkStudio(true).catch((err) => {
          log(` ✗ Studio check failed: ${err.message}`);
        });
        break;

      case 'sync-diff': {
        const local = sync.readLocal(userDir);
        if (studioState.customjs === null && local === null) {
          log(' Nothing to diff — no custom JS locally or in Studio');
          break;
        }
        const diff = sync.renderDiff(userDir, local, studioState.customjs, 'local-custom.js', 'studio-custom.js');
        const diffLines = diff.split('\n');
        log('');
        log(' ── local custom.js vs Studio ──────');
        diffLines.slice(0, 80).forEach((line) => log(` ${line}`));
        if (diffLines.length > 80) {
          log(` ${ansi.dim}... ${diffLines.length - 80} more lines (see custom.remote.js)${ansi.reset}`);
        }
        log(' ───────────────────────────────────');
        log('');
        break;
      }

      case 'sync-pull':
        pullFromStudio();
        break;

      case 'status': {
        const { port, host } = creativeConfig.server;
        const syncStatus = getSyncStatus();
        log('');
        log(' ── Server Status ──────────────────');
        log(` Creative ID : ${creativeConfig.creativeId}`);
        log(` Flowline    : ${creativeConfig.flowlineName}`);
        log(` Flowline ID : ${creativeConfig.flowlineId}`);
        log(` Sizes       : ${creativeConfig.sizes.join(', ') || 'N/A'}`);
        log(` Is Fluid    : ${creativeConfig.isFluid}`);
        log(` Server      : http://${host}:${port}`);
        log(` Directory   : ${userDir}`);
        log(` Browsers    : ${clients.size} connected`);
        log(` Studio sync : ${describeSyncState(syncStatus.state)}${syncStatus.summary ? ` (${syncStatus.summary})` : ''}`);
        log(` Last check  : ${syncStatus.checkedAt || 'never'}${syncStatus.error ? ` — ${syncStatus.error}` : ''}`);
        log(' ───────────────────────────────────');
        log('');
        break;
      }

      case 'clear':
        tui.clearLogs();
        break;

      case 'restart': {
        log(' Restarting server...');
        const { port, host } = creativeConfig.server;
        server.close(() => {
          listenOnAvailablePort(host, port)
            .then((activePort) => {
              creativeConfig.server.port = activePort;
              log(` Server restarted on http://${host}:${activePort}`);
              broadcastReload();
            })
            .catch((err) => {
              log(` ✗ Could not restart server: ${err.message}`);
            });
        });
        break;
      }

      case 'stop':
        gracefulShutdown();
        break;
    }
  }

  tui.init({
    menuItems: getMainMenuItems(),
    onSelect: handleSelect,
  });
}

// ============================================================
// Module Exports & Startup
// ============================================================

// Export functions for use by cli.js
module.exports = {
  fetchCreativeConfig,
  startServer: start
};

// Only auto-start if run directly (not required as module)
if (!isModule) {
  start();
}

// Graceful shutdown
function gracefulShutdown() {
  if (isShuttingDown) {
    console.log('\n Force exiting...\n');
    process.exit(130);
  }
  isShuttingDown = true;

  if (studioPollTimer) {
    clearInterval(studioPollTimer);
    studioPollTimer = null;
  }

  if (tui) {
    tui.destroy();
  }
  console.log('\n Shutting down...');
  console.log(' Press Ctrl+C again to force exit');

  // Ensure websocket clients do not keep the process alive.
  clients.forEach((client) => {
    try {
      client.terminate();
    } catch (_) {
      // Ignore client termination failures during shutdown.
    }
  });

  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }

  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }

  const forceTimer = setTimeout(() => {
    activeSockets.forEach((socket) => {
      try {
        socket.destroy();
      } catch (_) {
        // Ignore socket destroy failures during forced shutdown.
      }
    });
    console.log(' Forced shutdown: closed remaining connections');
    process.exit(0);
  }, 2000);

  Promise.allSettled([
    Promise.resolve().then(() => watcher.close()),
    new Promise((resolve) => wss.close(resolve)),
    new Promise((resolve) => server.close(resolve)),
  ]).finally(() => {
    clearTimeout(forceTimer);
    console.log(' Server stopped\n');
    process.exit(0);
  });
}

process.on('SIGINT', gracefulShutdown);

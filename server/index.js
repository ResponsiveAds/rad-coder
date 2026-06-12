const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const TUI = require('./tui');

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

/**
 * Fetch and parse creative configuration from studio preview page
 */
async function fetchCreativeConfig(creativeId) {
  const previewUrl = `https://studio.responsiveads.com/creatives/${creativeId}/preview`;
  
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
    let customjs = null;
    const creativeObj = extractJsonObject(html, 'window.creative = ');
    if (creativeObj && creativeObj.config && creativeObj.config.customjs) {
      customjs = creativeObj.config.customjs;
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

// Serve project-local test.html when available so users can customize it per creative
app.get('/test.html', (req, res) => {
  const localTestHtmlPath = path.join(userDir, 'test.html');
  if (fs.existsSync(localTestHtmlPath)) {
    res.sendFile(localTestHtmlPath);
    return;
  }

  const packageTestHtmlPath = path.join(packageDir, 'public', 'test.html');
  res.sendFile(packageTestHtmlPath);
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
});

watcher.on('error', (error) => {
  log(` Watcher error: ${error.message}`);
});

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
  console.log(` Test page: http://${host}:${activePort}/test.html`);
  console.log(`\n Working directory: ${userDir}`);
  console.log(' Edit custom.js and save to hot-reload\n');

  // Small delay to ensure server is fully ready before opening browser
  await new Promise(resolve => setTimeout(resolve, 500));

  // Auto-open browser unless disabled
  if (!noBrowserMode) {
    try {
      const open = (await import('open')).default;
      await open(`http://${host}:${activePort}/test.html`);
      console.log(' Browser opened automatically');
    } catch (err) {
      console.log(` Could not auto-open browser: ${err.message}`);
      console.log(` Please open http://${host}:${activePort}/test.html manually`);
    }
  } else {
    console.log(' Browser auto-open disabled (--no-ui)');
  }

  // Auto-open editor (unless --no-editor)
  if (!process.env.RAD_CODER_NO_EDITOR) {
    openEditor();
  }

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
          mod.default(`http://${host}:${port}/test.html`);
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

      case 'status': {
        const { port, host } = creativeConfig.server;
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

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
const studio = require('./studio');
const formats = require('./formats');

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

function preferredPortFromEnv() {
  const envPort = Number.parseInt(process.env.RAD_CODER_PORT || '', 10);
  return Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 ? envPort : 3000;
}

/**
 * Fetch and parse creative configuration from studio preview page
 */
async function fetchCreativeConfig(creativeId) {
  const previewUrl = studio.previewUrlFor(creativeId);

  log(` Fetching creative config from studio...`);
  log(` URL: ${previewUrl}\n`);

  try {
    const response = await fetch(previewUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const parsed = studio.parsePreview(await response.text(), creativeId);
    const studioCode = studio.applyFakes({ ok: true, customjs: parsed.customjs, formats: parsed.formats, error: null });
    if (!studioCode.ok) throw new Error(studioCode.error);

    const flowlines = parsed.flowlines;
    if (!flowlines) {
      throw new Error('Could not find or parse window.flowlines in preview page');
    }
    if (flowlines.length === 0) {
      throw new Error('No flowlines found for this creative');
    }

    const sizesOf = (f) => (f.flowline && f.flowline.sizes)
      || (f.fluidLayouts ? f.fluidLayouts.map(l => `${l.width}x${l.height}`) : []);

    // Select first flowline by default
    const fl = flowlines[0];

    return {
      creativeId: parsed.creativeId,
      flowlineId: fl._id || fl.id,
      flowlineName: fl.name || 'Unknown',
      sizes: sizesOf(fl),
      isFluid: fl.fullyFluid || false,
      adSource: '//edit.responsiveads.com/ads/',
      flSource: '//edit.responsiveads.com/flowlines/',
      radicalScript: 'https://studio.responsiveads.com/js/libs/radical.min.js',
      server: {
        port: preferredPortFromEnv(),
        host: 'localhost'
      },
      // Store all flowlines for reference
      allFlowlines: flowlines.map(f => ({
        id: f._id || f.id,
        name: f.name,
        sizes: sizesOf(f),
        isFluid: f.fullyFluid,
        isCreativeSpecific: f.isCreativeSpecific !== false,
        hasFormatJs: !!studioCode.formats[f._id || f.id]
      })),
      // Custom JS from the creative (if available)
      customjs: studioCode.customjs,
      // Format JS per flowline, as in Studio — never sent to the browser as-is
      formats: studioCode.formats,
      // Which flowlines the local format.js belongs to (set by the CLI)
      format: null
    };

  } catch (error) {
    log(`\n ✗ Failed to fetch creative config: ${error.message}\n`);
    process.exit(1);
  }
}

/**
 * Select a flowline by id or by (case-insensitive) part of its name.
 * @returns {object|null} the flowline selected, or null if nothing matched
 */
function selectFlowline(config, query) {
  if (!query) return null;
  const q = String(query).toLowerCase();
  const fl = config.allFlowlines.find(f => f.id === query)
    || config.allFlowlines.find(f => (f.name || '').toLowerCase().includes(q));
  if (!fl) return null;
  config.flowlineId = fl.id;
  config.flowlineName = fl.name;
  config.sizes = fl.sizes || [];
  config.isFluid = fl.isFluid || false;
  return fl;
}

// ============================================================
// Express Server Setup
// ============================================================

const app = express();

// The dev server listens on both loopback addresses, so http://localhost:<port>
// and http://127.0.0.1:<port> both reach it. Client test pages load their ad
// frame from the other name to get a cross-origin frame, like a GAM SafeFrame
// (see public/rad/harness.js). Only loopback: nothing is exposed to the network.
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];
let servers = [];

// Track active HTTP sockets so shutdown can force-close stragglers.
const activeSockets = new Set();
let isShuttingDown = false;

// WebSocket server for hot-reload (shared by every listening server)
const wss = new WebSocketServer({ noServer: true });

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

function createHttpServer() {
  const srv = http.createServer({ maxHeaderSize: 65536 }, app);
  srv.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });
  srv.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  return srv;
}

// Broadcast reload message to all connected browsers
function broadcastReload(file = null) {
  const message = JSON.stringify({ type: 'reload', file });
  clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}

// Enable CORS for all origins (needed for cross-origin script loading)
app.use(cors());

const customJsPath = path.join(userDir, 'custom.js');
const formatJsPath = path.join(userDir, 'format.js');
const pagesDir = path.join(userDir, 'pages');

function noStore(res) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
}

/** JSON that is safe to put inside an inline <script> */
function inlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function injectIntoHead(html, snippet) {
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], `${head[0]}\n  ${snippet}`);
  return snippet + html;
}

function injectBeforeBodyEnd(html, snippet) {
  return html.includes('</body>') ? html.replace('</body>', `  ${snippet}\n</body>`) : html + snippet;
}

function sendHtml(res, html) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(html);
}

const SYNC_BANNER = '<script src="/rad-sync-banner.js"></script>';

function sendTestHtml(res) {
  const localTestHtmlPath = path.join(userDir, 'test.html');
  const packageTestHtmlPath = path.join(packageDir, 'public', 'test.html');
  const testHtmlPath = fs.existsSync(localTestHtmlPath) ? localTestHtmlPath : packageTestHtmlPath;

  // Inject the sync banner and the format JS server-side rather than shipping
  // them in test.html: every project folder keeps its own copy of test.html, so
  // editing the packaged file would never reach projects that already exist.
  let html;
  try {
    html = fs.readFileSync(testHtmlPath, 'utf-8');
  } catch (err) {
    res.status(500).send(`Could not read test.html: ${err.message}`);
    return;
  }

  html = injectIntoHead(html, '<script src="/rad/test-format.js"></script>');
  html = injectBeforeBodyEnd(html, SYNC_BANNER);
  sendHtml(res, html);
}

// Serve project-local test.html when available so users can customize it per creative
app.get('/', (req, res) => {
  sendTestHtml(res);
});

app.get('/test.html', (req, res) => {
  sendTestHtml(res);
});

// ------------------------------------------------------------
// Format JS
// ------------------------------------------------------------

/** Public description of what format.js is and where it applies */
function formatInfo() {
  const fmt = creativeConfig && creativeConfig.format;
  const ids = creativeConfig ? creativeConfig.allFlowlines.map(f => f.id) : [];
  const groups = creativeConfig ? formats.distinctFormats(ids, studioState.formats) : [];
  const nameOf = (id) => {
    const fl = creativeConfig && creativeConfig.allFlowlines.find(f => f.id === id);
    return fl ? fl.name : id;
  };
  return {
    file: 'format.js',
    hasLocal: fs.existsSync(formatJsPath),
    flowlineId: fmt ? fmt.flowlineId : null,
    flowlineName: fmt ? fmt.flowlineName : null,
    appliesTo: fmt ? fmt.appliesTo : [],
    // false: the format is shared by other creatives — pasting it changes them too
    isCreativeSpecific: fmt ? fmt.isCreativeSpecific : true,
    // flowlines with a different format JS in Studio (rendered with Studio's code)
    others: groups
      .filter(g => !(fmt && g.some(id => fmt.appliesTo.includes(id))))
      .map(g => ({ flowlineIds: g, names: g.map(nameOf) })),
  };
}

/**
 * The format JS a flowline renders with: the local format.js for the flowlines it
 * belongs to, Studio's format JS for every other flowline.
 */
function formatJsFor(flowlineId) {
  const fmt = creativeConfig && creativeConfig.format;
  if (fmt && fmt.appliesTo.includes(flowlineId)) {
    const local = sync.readLocal(userDir, 'format');
    if (local !== null) return { code: local, source: 'local', file: 'format.js' };
  }
  const studioCode = studioState.formats[flowlineId];
  if (studioCode) return { code: studioCode, source: 'studio', file: null };
  return { code: '', source: 'none', file: null };
}

/** Recompute which flowlines share the owner's format JS (after a Studio change) */
function refreshFormatGroup() {
  const fmt = creativeConfig && creativeConfig.format;
  if (!fmt) return;
  const ids = creativeConfig.allFlowlines.map(f => f.id);
  fmt.appliesTo = formats.appliesTo(fmt.flowlineId, ids, studioState.formats);
  creativeConfig.allFlowlines.forEach((f) => { f.hasFormatJs = !!studioState.formats[f.id]; });
}

/** format.js appeared and belongs to no flowline yet: it belongs to the one being tested */
function claimFormatOwner() {
  const fl = creativeConfig.allFlowlines.find(f => f.id === creativeConfig.flowlineId) || creativeConfig.allFlowlines[0];
  creativeConfig.format = {
    flowlineId: fl.id,
    flowlineName: fl.name,
    appliesTo: [fl.id],
    isCreativeSpecific: fl.isCreativeSpecific !== false,
  };
  updateProjectConfig({ format: { ...creativeConfig.format } });
  log(` format.js is the format JS of flowline "${fl.name}"`);
}

/** Merge a patch into .rad-coder.json (best effort) */
function updateProjectConfig(patch) {
  const configPath = path.join(userDir, '.rad-coder.json');
  try {
    let current = {};
    try { current = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch (_) { /* new file */ }
    const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  } catch (err) {
    log(` ${ansi.dim}Could not update .rad-coder.json: ${err.message}${ansi.reset}`);
  }
}

app.get('/api/format-js', (req, res) => {
  noStore(res);
  if (!creativeConfig) {
    res.status(503).json({ error: 'Config not yet loaded' });
    return;
  }
  const flowlineId = typeof req.query.flowline === 'string' && req.query.flowline
    ? req.query.flowline
    : creativeConfig.flowlineId;
  res.json({ flowlineId, ...formatJsFor(flowlineId), format: formatInfo() });
});

// Loaded by test.html (injected into <head>):
//   - ?flowline=<id or part of the name> renders another format (flowline) of the
//     creative, and a Format menu in the toolbar switches between them;
//   - hands the format JS to Radical as flowlineCustomjs and, like a live
//     deployment script, runs a second copy in the page once Radical has loaded.
// Injected rather than built into test.html: every project keeps its own copy of
// test.html, so changes there would never reach existing projects.
app.get('/rad/test-format.js', (req, res) => {
  noStore(res);
  res.type('application/javascript');
  const codes = [];
  const byFlowline = {};
  const flowlines = [];
  for (const fl of creativeConfig ? creativeConfig.allFlowlines : []) {
    const { code, source } = formatJsFor(fl.id);
    flowlines.push({ id: fl.id, name: fl.name, sizes: fl.sizes || [], isFluid: !!fl.isFluid, code: code ? source : null });
    if (!code) continue;
    let index = codes.indexOf(code);
    if (index === -1) { codes.push(code); index = codes.length - 1; }
    byFlowline[fl.id] = index;
  }
  const data = { codes, byFlowline, flowlines, defaultFlowline: creativeConfig ? creativeConfig.flowlineId : null };
  res.send(`${TEST_FORMAT_SOURCE}(${inlineJson(data)});\n//# sourceURL=rad-coder-test-format.js\n`);
});

const TEST_FORMAT_SOURCE = `(function (data) {
  var params = new URLSearchParams(location.search);
  var noformat = params.get('noformat') === '1';
  if (noformat) console.info('[rad-coder] format JS disabled (?noformat=1)');

  // ?flowline=<id or part of the name>: render that format instead of the default
  var wanted = params.get('flowline');
  var chosen = null;
  if (wanted) {
    var q = wanted.toLowerCase();
    chosen = data.flowlines.filter(function (f) { return f.id === wanted; })[0] ||
      data.flowlines.filter(function (f) { return (f.name || '').toLowerCase().indexOf(q) !== -1; })[0] || null;
    if (!chosen) console.warn('[rad-coder] ?flowline=' + wanted + ' matches no format of this creative');
  }
  var shown = null;

  var pending = [];
  function patch(entry) {
    var opts = entry && entry[1];
    if (!opts || typeof opts !== 'object') return;
    if (chosen && opts.flowline !== chosen.id) {
      opts.flowline = chosen.id;
      opts.sizes = chosen.sizes;
      opts.isFluid = chosen.isFluid;
    }
    if (shown === null) {
      shown = opts.flowline;
      setTimeout(picker, 0);
    }
    if (noformat) return;
    var index = data.byFlowline[opts.flowline];
    if (index === undefined) return;
    var def = opts.config && opts.config._default;
    if (opts.flowlineCustomjs || (def && def.flowlineCustomjs)) return; // the page brought its own
    opts.config = opts.config || {};
    opts.config._default = opts.config._default || {};
    opts.config._default.flowlineCustomjs = data.codes[index];
    if (pending.indexOf(index) === -1) pending.push(index);
  }
  var queue = window.Radical = window.Radical || [];
  if (Array.isArray(queue)) {
    queue.forEach(patch);
    var push = queue.push;
    queue.push = function () {
      for (var i = 0; i < arguments.length; i++) patch(arguments[i]);
      return push.apply(this, arguments);
    };
  }
  // Live, the format JS is also appended to the deployment script d-<id>.js, so a
  // second copy runs in the tag's window right after the library loaded.
  document.addEventListener('load', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'SCRIPT' || !/radical[^\\/]*\\.js/i.test(el.src || '')) return;
    pending.splice(0).forEach(function (index) {
      var s = document.createElement('script');
      s.className = 'rad-coder-deployment-format-js';
      s.textContent = '// Deployment specific custom format JS (simulated by rad-coder)\\n' + data.codes[index];
      document.head.appendChild(s);
    });
  }, true);

  // The Format menu, in place of the flowline name in the toolbar
  function picker() {
    var slot = document.getElementById('flowline-name');
    if (!slot || data.flowlines.length < 2 || slot.querySelector('select')) return;
    var label = document.createElement('label');
    label.style.cssText = 'display:inline-flex;align-items:center;gap:6px;cursor:pointer';
    label.appendChild(document.createTextNode('Format'));
    var select = document.createElement('select');
    select.id = 'rad-format-picker';
    select.style.cssText = 'max-width:340px;padding:2px 4px;border:1px solid #1f4b8a;border-radius:4px;background:#0f3460;color:#fff;font:inherit';
    data.flowlines.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f.id;
      o.textContent = f.name + (f.code === 'local' ? '  · format.js' : f.code === 'studio' ? '  · format JS from Studio' : '');
      o.selected = f.id === shown;
      select.appendChild(o);
    });
    select.onchange = function () {
      var p = new URLSearchParams(location.search);
      if (select.value === data.defaultFlowline) p.delete('flowline');
      else p.set('flowline', select.value);
      var qs = p.toString();
      location.assign(location.pathname + (qs ? '?' + qs : ''));
    };
    label.appendChild(select);
    slot.textContent = '';
    slot.appendChild(label);
  }
})`;

// ------------------------------------------------------------
// Client test pages (pages/*.html)
// ------------------------------------------------------------

function listPages() {
  let names = [];
  try {
    names = fs.readdirSync(pagesDir).filter(f => f.endsWith('.html')).sort();
  } catch (_) {
    return [];
  }
  return names.map((name) => {
    let title = name;
    try {
      const m = fs.readFileSync(path.join(pagesDir, name), 'utf-8').match(/<title>([^<]*)<\/title>/i);
      if (m && m[1].trim()) title = m[1].trim();
    } catch (_) { /* keep the file name */ }
    return { name, title, path: `pages/${name}`, url: `/pages/${encodeURIComponent(name)}` };
  });
}

app.get('/api/pages', (req, res) => {
  noStore(res);
  res.json({ pages: listPages() });
});

// Pages get the hot-reload client and the sync banner injected, like test.html
app.get(/^\/pages\/(.+\.html)$/, (req, res, next) => {
  let file;
  try {
    file = path.resolve(pagesDir, decodeURIComponent(req.params[0]));
  } catch (_) {
    next();
    return;
  }
  if (!file.startsWith(pagesDir + path.sep) || !fs.existsSync(file)) {
    next();
    return;
  }
  let html = fs.readFileSync(file, 'utf-8');
  html = injectBeforeBodyEnd(html, `<script src="/rad/live.js"></script>\n  ${SYNC_BANNER}`);
  sendHtml(res, html);
});

// Everything else in pages/ (images, CSS, scripts the page uses)
app.use('/pages', express.static(pagesDir, {
  index: false,
  dotfiles: 'ignore',
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));

// Starting points for agents and people: curl them into the project folder
app.get('/rad/templates/:name', (req, res) => {
  const allowed = { 'page.html': 'page.html', 'format.js': 'format.js' };
  const name = allowed[req.params.name];
  if (!name) {
    res.status(404).send('Unknown template');
    return;
  }
  noStore(res);
  res.type('text/plain; charset=utf-8');
  res.sendFile(path.join(packageDir, 'templates', name));
});

// Reference docs for agents (DCO, troubleshooting): curl them when needed
app.get('/rad/docs/:name', (req, res) => {
  const allowed = { 'dynamic-content.md': 1, 'troubleshooting.md': 1 };
  if (!allowed[req.params.name]) {
    res.status(404).type('text/plain').send('Available: ' + Object.keys(allowed).join(', '));
    return;
  }
  noStore(res);
  res.type('text/markdown; charset=utf-8');
  res.sendFile(path.join(packageDir, 'docs', req.params.name));
});

// Serve static files from public directory (in package)
app.use(express.static(path.join(packageDir, 'public')));

// Serve the custom JS code as a JSON response (for injection into Radical config)
// Custom JS is in user's directory
app.get('/api/custom-js', (req, res) => {
  noStore(res);
  if (fs.existsSync(customJsPath)) {
    const code = fs.readFileSync(customJsPath, 'utf-8');
    res.json({ code });
  } else {
    res.json({ code: '// custom.js not found - create custom.js in your current directory' });
  }
});

function syncStatusJson(kind) {
  const status = getSyncStatus(kind);
  return {
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
  };
}

// Report how the local custom.js (top level) and format.js (`format`) compare to
// the versions currently in Studio
app.get('/api/sync-status', (req, res) => {
  noStore(res);
  const fmt = creativeConfig && creativeConfig.format;
  res.json({
    ...syncStatusJson('custom'),
    format: fmt || fs.existsSync(formatJsPath)
      ? { ...syncStatusJson('format'), flowlineId: fmt ? fmt.flowlineId : null, flowlineName: fmt ? fmt.flowlineName : null }
      : null,
  });
});

// Serve dynamically fetched config as JSON for the test page
app.get('/api/config', (req, res) => {
  noStore(res);
  if (!creativeConfig) {
    res.status(503).json({ error: 'Config not yet loaded' });
    return;
  }
  const { formats: _studioFormats, format: _format, ...publicConfig } = creativeConfig;
  res.json({ ...publicConfig, format: formatInfo() });
});

// ------------------------------------------------------------
// File watching
// ------------------------------------------------------------

// custom.js, format.js and pages/ (which may not exist yet — chokidar picks them
// up when they are created). Started by start(), after the CLI has written the
// project files, so creating them does not read as an edit.
let watcher = null;

function startWatching() {
  watcher = chokidar.watch([customJsPath, formatJsPath, pagesDir], {
    persistent: true,
    ignoreInitial: true,
    ignored: (p) => path.basename(p).startsWith('.') && p !== userDir,
  });
  watcher.on('all', onWatchedFileEvent);
  watcher.on('error', (error) => {
    log(` Watcher error: ${error.message}`);
  });
}

function onWatchedFileEvent(event, changedPath) {
  if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
  if (!creativeConfig) return;
  const rel = path.relative(userDir, changedPath);

  if (changedPath === formatJsPath) {
    if (event === 'add' && !creativeConfig.format) claimFormatOwner();
    if (event === 'unlink') log(` format.js removed — flowlines render with Studio's format JS`);
  }

  log(` File ${event === 'add' ? 'added' : event === 'unlink' ? 'removed' : 'changed'}: ${rel}`);
  log(' Reloading browsers...');
  broadcastReload(rel);

  // If the save just brought us level with Studio, say so — and remember it,
  // so we stop treating the difference as unpushed work.
  const kind = changedPath === customJsPath ? 'custom' : changedPath === formatJsPath ? 'format' : null;
  if (kind && event !== 'unlink') {
    const remote = studioState[kind].code;
    if (remote !== null && sync.sameCode(sync.readLocal(userDir, kind), remote)) {
      sync.writeBase(userDir, remote, kind);
      sync.removeRemoteCopy(userDir, kind);
      log(` ${ansi.green}✓ ${sync.kindInfo(kind).file} now matches Studio${ansi.reset}`);
    }
  }
}

// ============================================================
// Studio Sync Watch
// ============================================================

// Studio's custom JS and format JS can be edited by anyone at any time. Poll for
// them so a session that has been open for hours notices before a local file is
// pasted back over somebody else's work.
const studioState = {
  checkedAt: null,     // ISO timestamp of the last successful check
  error: null,         // last fetch error, if the most recent check failed
  // Per kind: last code observed in Studio, when it last changed under us, and
  // where that version was archived. `format` is the format.js owner's format JS.
  custom: { code: null, changedAt: null, archivedPath: null },
  format: { code: null, changedAt: null, archivedPath: null },
  formats: {},         // every flowline's format JS as last seen in Studio
};
let studioPollTimer = null;
let lastLoggedStudioError = null;

const KIND_LABEL = { custom: 'custom JS', format: 'format JS' };

function studioPollInterval() {
  const raw = process.env.RAD_CODER_STUDIO_POLL_MS;
  if (raw === undefined) return 60000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return 60000;
  return parsed; // 0 disables polling
}

/** Current local-vs-Studio state, computed fresh from disk */
function getSyncStatus(kind = 'custom') {
  const local = sync.readLocal(userDir, kind);
  const remote = studioState[kind].code;
  const status = sync.classify({
    local,
    remote,
    base: sync.readBase(userDir, kind),
  });

  return {
    ...status,
    checkedAt: studioState.checkedAt,
    changedAt: studioState[kind].changedAt,
    error: studioState.error,
    archivedPath: studioState[kind].archivedPath
      ? sync.relative(userDir, studioState[kind].archivedPath)
      : null,
    // Always expressed as "what Studio has that local does not"
    summary: status.state === 'in-sync' || status.state === 'no-local'
      ? null
      : sync.diffSummary(local, remote),
  };
}

/**
 * Record a freshly fetched Studio version of one kind of code.
 * @returns {boolean} whether Studio changed
 */
function observeStudio(kind, code) {
  const state = studioState[kind];
  if (sync.sameCode(code, state.code)) {
    state.code = code;
    return false;
  }

  const { file, remote: remoteName, studioField } = sync.kindInfo(kind);
  const label = KIND_LABEL[kind];

  // Studio moved. Keep a copy of the version we are about to stop seeing.
  state.code = code;
  state.changedAt = studioState.checkedAt;
  state.archivedPath = sync.archiveRemote(userDir, code, kind);

  const local = sync.readLocal(userDir, kind);
  if (local === null) {
    log(` ${ansi.dim}Studio's ${label} changed (${studioField}); there is no local ${file}${ansi.reset}`);
    return true;
  }
  if (sync.sameCode(local, code)) {
    sync.writeBase(userDir, code, kind);
    sync.removeRemoteCopy(userDir, kind);
    log('');
    log(` ${ansi.green}✓ Studio now matches your local ${file} — in sync${ansi.reset}`);
    log('');
    return true;
  }

  const remoteCopy = sync.writeRemoteCopy(userDir, code, kind);
  log('');
  log(` ${ansi.yellow}${ansi.bold}⚠ STUDIO CHANGED — someone edited this creative's ${label}${ansi.reset}`);
  log(` ${ansi.yellow}  your local ${file} no longer matches Studio (${studioField})${ansi.reset}`);
  log(` ${ansi.yellow}  Studio vs your local: ${sync.diffSummary(local, code)}${ansi.reset}`);
  log(` ${ansi.yellow}  Studio version → ${sync.relative(userDir, remoteCopy)}${ansi.reset}`);
  if (state.archivedPath) {
    log(` ${ansi.yellow}  archived copy  → ${sync.relative(userDir, state.archivedPath)}${ansi.reset}`);
  }
  log(` ${ansi.yellow}  ► Do NOT paste your local ${file} into Studio before diffing the two (${remoteName})${ansi.reset}`);
  log('');
  return true;
}

/**
 * Check Studio once. Reports only real changes, so it is quiet by default.
 * @param {boolean} announce - log even when nothing changed (manual check)
 */
async function checkStudio(announce = false) {
  const id = creativeConfig ? creativeConfig.creativeId : creativeId;
  const result = await studio.fetchStudioCode(id);

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

  let changed = observeStudio('custom', result.customjs);
  if (result.formats) {
    const previous = studioState.formats;
    const changedIds = Object.keys({ ...previous, ...result.formats })
      .filter(fid => !sync.sameCode(previous[fid], result.formats[fid]));
    studioState.formats = result.formats;
    if (changedIds.length) {
      const fmtBefore = creativeConfig && creativeConfig.format ? creativeConfig.format.appliesTo.join() : '';
      refreshFormatGroup();
      const fmtNow = creativeConfig && creativeConfig.format ? creativeConfig.format.appliesTo : [];
      // Reload only when what a page renders changed: a flowline that uses Studio's
      // format JS, or a change in which flowlines use format.js
      if (fmtNow.join() !== fmtBefore || changedIds.some(fid => !fmtNow.includes(fid))) broadcastReload();
    }
    const fmt = creativeConfig && creativeConfig.format;
    if (fmt) changed = observeStudio('format', result.formats[fmt.flowlineId] || null) || changed;
  }

  if (!changed && announce) {
    const parts = [`custom.js: ${describeSyncState(getSyncStatus('custom').state)}`];
    if (creativeConfig && creativeConfig.format) parts.push(`format.js: ${describeSyncState(getSyncStatus('format').state)}`);
    log(` ${ansi.dim}Studio unchanged (${parts.join('; ')})${ansi.reset}`);
  }

  return getSyncStatus();
}

function describeSyncState(state) {
  switch (state) {
    case 'in-sync': return 'local matches Studio';
    case 'local-ahead': return 'local edits not in Studio yet';
    case 'remote-ahead': return 'Studio is newer than local';
    case 'diverged': return 'CONFLICT — both sides changed';
    case 'unknown-divergence': return 'CONFLICT — differ, no sync history';
    case 'no-local': return 'no local file';
    default: return state;
  }
}

function startStudioWatch() {
  // Seed from the config already fetched at startup so the state cli.js just
  // reported is not immediately re-reported here.
  if (creativeConfig && studioState.checkedAt === null) {
    studioState.custom.code = creativeConfig.customjs;
    studioState.formats = creativeConfig.formats || {};
    const fmt = creativeConfig.format;
    studioState.format.code = fmt ? studioState.formats[fmt.flowlineId] || null : null;
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
function pullFromStudio(kind = 'custom') {
  const { file } = sync.kindInfo(kind);
  const code = studioState[kind].code;
  if (code === null) {
    log(` Nothing to pull — Studio has no ${KIND_LABEL[kind]}`);
    return;
  }

  const backup = sync.backupLocal(userDir, kind);
  fs.writeFileSync(path.join(userDir, file), code, 'utf-8');
  sync.writeBase(userDir, code, kind);
  sync.removeRemoteCopy(userDir, kind);
  log(` ${ansi.green}↓ Pulled ${file} from Studio${ansi.reset}`);
  if (backup) {
    log(`   Previous version saved to ${sync.relative(userDir, backup)}`);
  }
  broadcastReload(file);
}

function showDiff(kind = 'custom') {
  const { file, remote } = sync.kindInfo(kind);
  const local = sync.readLocal(userDir, kind);
  const code = studioState[kind].code;
  if (code === null && local === null) {
    log(` Nothing to diff — no ${KIND_LABEL[kind]} locally or in Studio`);
    return;
  }
  const diff = sync.renderDiff(userDir, local, code, `local-${file}`, `studio-${file}`);
  const diffLines = diff.split('\n');
  log('');
  log(` ── local ${file} vs Studio ──────`);
  diffLines.slice(0, 80).forEach((line) => log(` ${line}`));
  if (diffLines.length > 80) {
    log(` ${ansi.dim}... ${diffLines.length - 80} more lines (see ${remote})${ansi.reset}`);
  }
  log(' ───────────────────────────────────');
  log('');
}

// ============================================================
// Start Server
// ============================================================

function listenOn(srv, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      srv.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      srv.off('error', onError);
      resolve();
    };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port, host);
  });
}

function closeServers() {
  const closing = servers.map(srv => new Promise(resolve => srv.close(() => resolve())));
  servers = [];
  return Promise.all(closing);
}

/**
 * Listen on every loopback address at the first port (from preferredPort up)
 * that is free on all of them. IPv4 loopback is required; IPv6 loopback is used
 * when the machine has it.
 */
async function listenOnAvailablePort(preferredPort, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = preferredPort + i;
    const bound = [];
    let busy = false;

    for (const [index, host] of LOOPBACK_HOSTS.entries()) {
      const srv = createHttpServer();
      try {
        await listenOn(srv, host, port);
        bound.push(srv);
      } catch (err) {
        if (err && err.code === 'EADDRINUSE') {
          busy = true;
          break;
        }
        if (index === 0) {
          await Promise.all(bound.map(s => new Promise(r => s.close(() => r()))));
          throw err;
        }
        // No IPv6 loopback on this machine — IPv4 alone is fine
      }
    }

    if (busy) {
      await Promise.all(bound.map(s => new Promise(r => s.close(() => r()))));
      continue;
    }

    servers = bound;
    if (i > 0) {
      console.log(`\n Port ${preferredPort} is in use. Using port ${port} instead.`);
    }
    return port;
  }

  throw new Error(`Could not find an available port in range ${preferredPort}-${preferredPort + maxAttempts - 1}`);
}

/** Page the browser opens: test.html, or the client page given with --page */
function openUrl() {
  const { port, host } = creativeConfig.server;
  const openPath = process.env.RAD_CODER_OPEN_PATH || '/';
  return `http://${host}:${port}${openPath.startsWith('/') ? openPath : `/${openPath}`}`;
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

  // Watch Studio for custom JS / format JS edits made by other people. Seeded
  // before listening, so the first page load already gets Studio's format JS.
  startStudioWatch();
  startWatching();

  console.log(' Creative Config:');
  console.log(` - Creative ID: ${creativeConfig.creativeId}`);
  console.log(` - Flowline: ${creativeConfig.flowlineName}`);
  console.log(` - Flowline ID: ${creativeConfig.flowlineId}`);
  console.log(` - Sizes: ${creativeConfig.sizes.join(', ')}`);
  console.log(` - Is Fluid: ${creativeConfig.isFluid}`);
  console.log(` - Has CustomJS: ${creativeConfig.customjs ? 'Yes' : 'No'}`);
  const fmtInfo = formatInfo();
  if (fmtInfo.flowlineId) {
    const copies = fmtInfo.appliesTo.length - 1;
    console.log(` - Format JS: format.js → "${fmtInfo.flowlineName}"${copies > 0 ? ` (+${copies} flowline${copies > 1 ? 's' : ''} with the same format JS)` : ''}`);
    if (!fmtInfo.appliesTo.includes(creativeConfig.flowlineId)) {
      console.log(`   The selected flowline does not use format.js — test it with --flowline=${fmtInfo.flowlineId}`);
    }
    if (!fmtInfo.isCreativeSpecific) {
      console.log('   ⚠ This format is shared with other creatives: pasting format.js into Studio changes all of them');
    }
  } else {
    console.log(' - Format JS: none');
  }
  fmtInfo.others.forEach((g) => {
    console.log(`   Different format JS in Studio (not in format.js): ${g.names.join(', ')}`);
  });

  if (creativeConfig.allFlowlines.length > 1) {
    console.log(`\n Available Flowlines (${creativeConfig.allFlowlines.length}):`);
    creativeConfig.allFlowlines.forEach((fl, i) => {
      const marker = fl.id === creativeConfig.flowlineId ? ' (selected)' : '';
      const fmt = fmtInfo.appliesTo.includes(fl.id) ? ' [format.js]' : fl.hasFormatJs ? ' [format JS]' : '';
      console.log(`   ${i + 1}. ${fl.name}${fmt}${marker}`);
    });
  }

  const pages = listPages();
  if (pages.length) {
    console.log(`\n Client test pages (${pages.length}):`);
    pages.forEach((p) => console.log(`   ${p.path}`));
  }

  const { port, host } = creativeConfig.server;
  const activePort = await listenOnAvailablePort(port);
  creativeConfig.server.port = activePort;

  console.log(`\n Server running at: http://${host}:${activePort}`);
  console.log(` Test page: http://${host}:${activePort}/`);
  if (process.env.RAD_CODER_OPEN_PATH) {
    console.log(` Client page: ${openUrl()}`);
  }
  console.log(`\n Working directory: ${userDir}`);
  console.log(` Edit custom.js${fmtInfo.flowlineId ? ' or format.js' : ''} and save to hot-reload\n`);

  // Small delay to ensure server is fully ready before opening browser
  await new Promise(resolve => setTimeout(resolve, 500));

  // Auto-open browser unless disabled
  if (!noBrowserMode) {
    try {
      const open = (await import('open')).default;
      await open(openUrl());
      console.log(' Browser opened automatically');
    } catch (err) {
      console.log(` Could not auto-open browser: ${err.message}`);
      console.log(` Please open ${openUrl()} manually`);
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

function hasFormat() {
  return !!(creativeConfig && (creativeConfig.format || fs.existsSync(formatJsPath)));
}

function getMainMenuItems() {
  const items = [
    { label: 'Open Browser', id: 'open-browser' },
    { label: 'Open Editor', id: 'open-editor' },
  ];

  if (listPages().length) {
    items.push({ label: 'Open Client Page', id: 'open-page' });
  }

  if (creativeConfig && creativeConfig.allFlowlines.length > 1) {
    items.push({ label: 'Switch Flowline', id: 'switch-flowline', description: `(${creativeConfig.flowlineName})` });
  }

  items.push(
    { label: 'Check Studio Now', id: 'sync-check' },
    { label: 'Diff vs Studio', id: 'sync-diff' },
    { label: 'Pull from Studio', id: 'sync-pull' },
  );

  if (hasFormat()) {
    items.push(
      { label: 'Diff format.js vs Studio', id: 'sync-diff-format' },
      { label: 'Pull format.js from Studio', id: 'sync-pull-format' },
    );
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
  const appliesTo = creativeConfig.format ? creativeConfig.format.appliesTo : [];
  creativeConfig.allFlowlines.forEach((fl, i) => {
    const marker = fl.id === creativeConfig.flowlineId ? ' ✓' : '';
    const fmt = appliesTo.includes(fl.id) ? ' [format.js]' : fl.hasFormatJs ? ' [format JS]' : '';
    items.push({ label: `${fl.name}${fmt}${marker}`, id: `flowline-${i}`, flowlineIndex: i });
  });
  return items;
}

function getPageMenuItems() {
  const items = [{ label: '← Back', id: 'back' }];
  listPages().forEach((p) => items.push({ label: p.title === p.name ? p.path : `${p.path} — ${p.title}`, id: `page-${p.name}`, url: p.url }));
  return items;
}

function openInBrowser(url) {
  import('open').then(mod => {
    mod.default(url);
    log(` Browser opened: ${url}`);
  }).catch(err => {
    log(` Could not open browser: ${err.message}`);
  });
}

function startInteractiveMenu() {
  tui = new TUI();

  let subMenu = null; // 'flowline' | 'page'

  function backToMain() {
    subMenu = null;
    tui.updateMenu(getMainMenuItems());
  }

  function handleSelect(item) {
    if (subMenu && item.id === 'back') {
      backToMain();
      return;
    }

    // Sub-menu: flowline selection
    if (subMenu === 'flowline') {
      const fl = creativeConfig.allFlowlines[item.flowlineIndex];
      if (fl) {
        selectFlowline(creativeConfig, fl.id);
        log(` Switched to flowline: ${fl.name}`);
        broadcastReload();
      }
      backToMain();
      return;
    }

    // Sub-menu: client test pages
    if (subMenu === 'page') {
      const { port, host } = creativeConfig.server;
      if (item.url) openInBrowser(`http://${host}:${port}${item.url}`);
      backToMain();
      return;
    }

    // Main menu actions
    switch (item.id) {
      case 'open-browser':
        openInBrowser(openUrl());
        break;

      case 'open-page':
        subMenu = 'page';
        tui.updateMenu(getPageMenuItems());
        break;

      case 'open-editor':
        openEditor();
        break;

      case 'switch-flowline':
        subMenu = 'flowline';
        tui.updateMenu(getFlowlineMenuItems());
        break;

      case 'sync-check':
        log(` Checking Studio for custom JS${hasFormat() ? ' and format JS' : ''} changes...`);
        checkStudio(true).catch((err) => {
          log(` ✗ Studio check failed: ${err.message}`);
        });
        break;

      case 'sync-diff':
        showDiff('custom');
        break;

      case 'sync-pull':
        pullFromStudio('custom');
        break;

      case 'sync-diff-format':
        showDiff('format');
        break;

      case 'sync-pull-format':
        pullFromStudio('format');
        break;

      case 'status': {
        const syncStatus = getSyncStatus('custom');
        const fmt = formatInfo();
        log('');
        log(' ── Server Status ──────────────────');
        log(` Creative ID : ${creativeConfig.creativeId}`);
        log(` Flowline    : ${creativeConfig.flowlineName}`);
        log(` Flowline ID : ${creativeConfig.flowlineId}`);
        log(` Sizes       : ${creativeConfig.sizes.join(', ') || 'N/A'}`);
        log(` Is Fluid    : ${creativeConfig.isFluid}`);
        log(` Server      : ${openUrl()}`);
        log(` Directory   : ${userDir}`);
        log(` Browsers    : ${clients.size} connected`);
        log(` Studio sync : ${describeSyncState(syncStatus.state)}${syncStatus.summary ? ` (${syncStatus.summary})` : ''}`);
        if (fmt.flowlineId) {
          const formatStatus = getSyncStatus('format');
          log(` Format JS   : format.js → ${fmt.flowlineName} (${fmt.appliesTo.length} flowline${fmt.appliesTo.length > 1 ? 's' : ''})`);
          log(` Format sync : ${describeSyncState(formatStatus.state)}${formatStatus.summary ? ` (${formatStatus.summary})` : ''}`);
        }
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
        closeServers()
          .then(() => listenOnAvailablePort(port))
          .then((activePort) => {
            creativeConfig.server.port = activePort;
            log(` Server restarted on http://${host}:${activePort}`);
            broadcastReload();
          })
          .catch((err) => {
            log(` ✗ Could not restart server: ${err.message}`);
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
  selectFlowline,
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

  servers.forEach((srv) => {
    if (typeof srv.closeIdleConnections === 'function') {
      srv.closeIdleConnections();
    }
    if (typeof srv.closeAllConnections === 'function') {
      srv.closeAllConnections();
    }
  });

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
    Promise.resolve().then(() => watcher && watcher.close()),
    new Promise((resolve) => wss.close(resolve)),
    closeServers(),
  ]).finally(() => {
    clearTimeout(forceTimer);
    console.log(' Server stopped\n');
    process.exit(0);
  });
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

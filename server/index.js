const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const http = require('http');

// ============================================================
// Directory Configuration
// ============================================================

// When run via npx, these are set by bin/cli.js
// When run directly for development, use defaults
const userDir = process.env.RAD_CODER_USER_DIR || process.cwd();
const packageDir = process.env.RAD_CODER_PACKAGE_DIR || path.join(__dirname, '..');

// ============================================================
// CLI Argument Parsing
// ============================================================

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
function extractCreativeId(input) {
  // If it's a URL, extract the ID
  const urlMatch = input.match(/creatives\/([a-f0-9]+)/i);
  return urlMatch ? urlMatch[1] : input;
}

const creativeId = extractCreativeId(input);

// ============================================================
// Fetch Creative Config from Studio Preview Page
// ============================================================

let creativeConfig = null;

/**
 * Fetch and parse creative configuration from studio preview page
 */
async function fetchCreativeConfig(creativeId) {
  const previewUrl = `https://studio.responsiveads.com/creatives/${creativeId}/preview`;
  
  console.log(` Fetching creative config from studio...`);
  console.log(` URL: ${previewUrl}\n`);
  
  try {
    const response = await fetch(previewUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const html = await response.text();
    
    // Extract window.creativeId
    const creativeIdMatch = html.match(/window\.creativeId\s*=\s*['"]([^'"]+)['"]/);
    const extractedCreativeId = creativeIdMatch ? creativeIdMatch[1] : creativeId;
    
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
  
    
    return {
      creativeId: extractedCreativeId,
      flowlineId: fl._id || fl.id,
      flowlineName: fl.name || 'Unknown',
      sizes: sizes,
      isFluid: fl.fullyFluid || false,
      adSource: '//publish.responsiveads.com/ads/',
      flSource: '//publish.responsiveads.com/flowlines/',
      radicalScript: 'https://publish.responsiveads.com/libs/radical.r8.min.js',
      server: {
        port: 3000,
        host: 'localhost'
      },
      // Store all flowlines for reference
      allFlowlines: flowlines.map(f => ({
        id: f._id || f.id,
        name: f.name,
        sizes: f.flowline?.sizes || [],
        isFluid: f.fullyFluid
      }))
    };
    
  } catch (error) {
    console.error(`\n Failed to fetch creative config: ${error.message}\n`);
    process.exit(1);
  }
}

// ============================================================
// Express Server Setup
// ============================================================

const app = express();
const server = http.createServer(app);

// WebSocket server for hot-reload
const wss = new WebSocketServer({ server });

// Track connected clients
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('Browser connected for hot-reload');
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log('Browser disconnected');
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

watcher.on('change', (filePath) => {
  console.log(`\n File changed: ${path.basename(filePath)}`);
  console.log(' Reloading browsers...\n');
  broadcastReload();
});

watcher.on('error', (error) => {
  console.error('Watcher error:', error);
});

// ============================================================
// Start Server
// ============================================================

async function start() {
  console.log('\n========================================');
  console.log(' RAD Coder - ResponsiveAds Creative Tester');
  console.log('========================================\n');
  
  // Fetch creative config from studio
  creativeConfig = await fetchCreativeConfig(creativeId);
  
  console.log(' Creative Config:');
  console.log(` - Creative ID: ${creativeConfig.creativeId}`);
  console.log(` - Flowline: ${creativeConfig.flowlineName}`);
  console.log(` - Flowline ID: ${creativeConfig.flowlineId}`);
  console.log(` - Sizes: ${creativeConfig.sizes.join(', ')}`);
  console.log(` - Is Fluid: ${creativeConfig.isFluid}`);
  
  if (creativeConfig.allFlowlines.length > 1) {
    console.log(`\n Available Flowlines (${creativeConfig.allFlowlines.length}):`);
    creativeConfig.allFlowlines.forEach((fl, i) => {
      const marker = i === 0 ? ' (selected)' : '';
      console.log(`   ${i + 1}. ${fl.name}${marker}`);
    });
  }
  
  const { port, host } = creativeConfig.server;
  
  server.listen(port, host, async () => {
    console.log(`\n Server running at: http://${host}:${port}`);
    console.log(` Test page: http://${host}:${port}/test.html`);
    console.log(`\n Working directory: ${userDir}`);
    console.log(' Edit custom.js and save to hot-reload\n');
    console.log(' Press Ctrl+C to stop\n');
    
    // Small delay to ensure server is fully ready before opening browser
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Auto-open browser
    try {
      const open = (await import('open')).default;
      await open(`http://${host}:${port}/test.html`);
      console.log(' Browser opened automatically\n');
    } catch (err) {
      console.log(' Could not auto-open browser:', err.message);
      console.log(` Please open http://${host}:${port}/test.html manually\n`);
    }
  });
}

start();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n Shutting down...');
  watcher.close();
  wss.close();
  server.close(() => {
    console.log(' Server stopped\n');
    process.exit(0);
  });
});

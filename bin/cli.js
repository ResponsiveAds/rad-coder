#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

// Get the package root directory
const packageRoot = path.join(__dirname, '..');

// Extract creative ID from input (can be a direct ID or a preview URL)
function extractCreativeId(input) {
  if (!input) return null;
  const urlMatch = input.match(/creatives\/([a-f0-9]+)/i);
  return urlMatch ? urlMatch[1] : input;
}

/**
 * Prompt user with a question and arrow-key selectable choices
 * @param {string} question - The question to ask
 * @param {string[]} choices - Array of choices
 * @returns {Promise<number>} - The index of the selected choice (0-based)
 */
function promptUser(question, choices) {
  return new Promise((resolve) => {
    let selected = 0;

    // Print question
    console.log(`\n${question}\n`);

    function draw() {
      // Move cursor up to overwrite previous menu lines
      if (selected !== -1) {
        process.stdout.write(`\x1B[${choices.length}A`);
      }
      for (let i = 0; i < choices.length; i++) {
        process.stdout.write('\x1B[2K'); // clear line
        if (i === selected) {
          process.stdout.write(`  \x1B[36m\x1B[1m❯ ${choices[i]}\x1B[0m\n`);
        } else {
          process.stdout.write(`    ${choices[i]}\n`);
        }
      }
    }

    // Initial draw (set selected to -1 so it doesn't move cursor up first time)
    const initial = selected;
    selected = -1;
    // Print placeholder lines first
    for (let i = 0; i < choices.length; i++) {
      process.stdout.write('\n');
    }
    // Move back up and draw properly
    process.stdout.write(`\x1B[${choices.length}A`);
    selected = initial;
    draw();

    // Enable raw mode for keypress detection
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    function onData(data) {
      const key = data.toString();

      // Ctrl+C
      if (key === '\x03') {
        cleanup();
        process.exit(0);
        return;
      }

      // Up arrow
      if (key === '\x1B[A') {
        selected = Math.max(0, selected - 1);
        draw();
        return;
      }

      // Down arrow
      if (key === '\x1B[B') {
        selected = Math.min(choices.length - 1, selected + 1);
        draw();
        return;
      }

      // Enter
      if (key === '\r' || key === '\n') {
        cleanup();
        resolve(selected);
        return;
      }

      // Number keys for quick select
      const num = parseInt(key, 10);
      if (num >= 1 && num <= choices.length) {
        selected = num - 1;
        draw();
        cleanup();
        resolve(selected);
        return;
      }
    }

    function cleanup() {
      process.stdin.removeListener('data', onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    }

    process.stdin.on('data', onData);
  });
}

// Get creative ID from command line argument (skip flags)
const args = process.argv.slice(2);
let input = null;
let editorFlag = null;
let noEditor = false;
let resetFlag = false;
let freshFlag = false;
let noUiFlag = false;
let portFlag = null;

for (const arg of args) {
  if (arg.startsWith('--editor=')) {
    editorFlag = arg.split('=')[1];
  } else if (arg.startsWith('--port=')) {
    const parsed = Number.parseInt(arg.split('=')[1], 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
      console.error(`Invalid --port value: ${arg.split('=')[1]}. Expected 1-65535.`);
      process.exit(1);
    }
    portFlag = parsed;
  } else if (arg === '--no-editor') {
    noEditor = true;
  } else if (arg === '--no-ui') {
    noUiFlag = true;
    noEditor = true;
  } else if (arg === '--reset') {
    resetFlag = true;
  } else if (arg === '--fresh') {
    freshFlag = true;
  } else if (!arg.startsWith('--')) {
    input = arg;
  }
}

// Pass editor preferences via environment variables
if (editorFlag) {
  process.env.RAD_CODER_EDITOR = editorFlag;
}
if (noEditor) {
  process.env.RAD_CODER_NO_EDITOR = '1';
}
if (portFlag !== null) {
  process.env.RAD_CODER_PORT = String(portFlag);
}
if (noUiFlag) {
  process.env.RAD_CODER_NO_UI = '1';
  process.env.RAD_CODER_NO_BROWSER = '1';
}

let creativeId = extractCreativeId(input);

// Auto-detect creative ID when no argument is given
if (!creativeId) {
  const cwd = process.cwd();

  // 1. Check for .rad-coder.json in current directory
  const configPath = path.join(cwd, '.rad-coder.json');
  if (fs.existsSync(configPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (saved.creativeId) {
        creativeId = saved.creativeId;
        console.log(`Detected creative from .rad-coder.json: ${creativeId}`);
      }
    } catch (_) { /* ignore malformed config */ }
  }

  // 2. Check if current directory name looks like a creative ID (24-char hex)
  if (!creativeId) {
    const dirName = path.basename(cwd);
    if (/^[a-f0-9]{24}$/i.test(dirName)) {
      creativeId = dirName;
      console.log(`Detected creative from folder name: ${creativeId}`);
    }
  }
}

if (!creativeId) {
  console.log('Usage: npx rad-coder <creativeId or previewUrl> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --editor=<cmd>   Set code editor command (default: code)');
  console.log('  --port=<number>  Preferred starting port (default: 3000)');
  console.log('  --no-editor      Don\'t auto-open code editor');
  console.log('  --no-ui          Non-interactive mode (no prompts/menu/browser/editor)');
  console.log('  --reset          Overwrite local custom.js with remote version');
  console.log('  --fresh          Delete local folder and start from scratch');
  console.log('');
  console.log('Examples:');
  console.log('  npx rad-coder 697b80fcc6e904025f5147a0');
  console.log('  npx rad-coder https://studio.responsiveads.com/creatives/697b80fcc6e904025f5147a0/preview');
  console.log('  npx rad-coder 697b80fcc6e904025f5147a0 --editor=cursor');
  console.log('  npx rad-coder 697b80fcc6e904025f5147a0 --port=3100 --no-ui');
  console.log('');
  console.log('Continue working (from inside a project folder):');
  console.log('  cd 697b80fcc6e904025f5147a0 && npx rad-coder');
  process.exit(1);
}

async function main() {
  // Determine the target directory
  const cwd = process.cwd();
  const currentDirName = path.basename(cwd);
  let userDir;
  let isNewProject = false;

  // Check if a .rad-coder.json exists in cwd (we're inside a project folder)
  const cwdConfigPath = path.join(cwd, '.rad-coder.json');
  const inProjectDir = fs.existsSync(cwdConfigPath) || currentDirName === creativeId;

  if (inProjectDir) {
    // Already in the correct folder
    userDir = cwd;
    console.log(`Using existing project: ${userDir}`);
  } else {
    // Create or use a folder with the creative ID
    userDir = path.join(cwd, creativeId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir);
      isNewProject = true;
      console.log(`Created folder: ./${creativeId}`);
    } else {
      console.log(`Using existing folder: ./${creativeId}`);
    }
  }

  // Handle --fresh: delete folder and recreate
  if (freshFlag && fs.existsSync(userDir)) {
    fs.rmSync(userDir, { recursive: true, force: true });
    fs.mkdirSync(userDir);
    isNewProject = true;
    console.log(`  Fresh start: deleted and recreated ./${creativeId}`);
  }

  // Set environment variables for the server
  process.env.RAD_CODER_USER_DIR = userDir;
  process.env.RAD_CODER_PACKAGE_DIR = packageRoot;

  // Import server module to fetch creative config
  const { fetchCreativeConfig, startServer } = require('../server/index.js');

  // Fetch creative config first to check for customjs
  const config = await fetchCreativeConfig(creativeId);

  const customJsPath = path.join(userDir, 'custom.js');
  const customJsExists = fs.existsSync(customJsPath);
  const hasCreativeCustomJs = config.customjs && config.customjs.trim().length > 0;

  // Handle custom.js file creation/update
  if (resetFlag && hasCreativeCustomJs) {
    // --reset: overwrite local custom.js with remote version
    fs.writeFileSync(customJsPath, config.customjs, 'utf-8');
    console.log('  Reset custom.js (from creative)');
  } else if (customJsExists) {
    // custom.js already exists — use it silently (zero-friction repeat run)
    console.log('  Using existing custom.js');
  } else if (hasCreativeCustomJs) {
    // First run with remote customjs available — prompt
    let choice = 0;
    if (!noUiFlag) {
      choice = await promptUser(
        'Found customJS in this creative. What would you like to use?',
        [
          'Use customJS from the creative (recommended)',
          'Start with blank template'
        ]
      );
    } else {
      console.log('  No-UI mode: using customJS from creative');
    }

    if (choice === 0) {
      fs.writeFileSync(customJsPath, config.customjs, 'utf-8');
      console.log('  Created custom.js (from creative)');
    } else {
      const templatePath = path.join(packageRoot, 'templates', 'custom.js');
      if (fs.existsSync(templatePath)) {
        fs.copyFileSync(templatePath, customJsPath);
        console.log('  Created custom.js (from template)');
      }
    }
  } else {
    // No customjs in creative — use template if custom.js doesn't exist
    const templatePath = path.join(packageRoot, 'templates', 'custom.js');
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, customJsPath);
      console.log('  Created custom.js (from template)');
    }
  }

  // Copy AGENTS.md if it doesn't exist
  const agentsMdPath = path.join(userDir, 'AGENTS.md');
  if (!fs.existsSync(agentsMdPath)) {
    const templatePath = path.join(packageRoot, 'templates', 'AGENTS.md');
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, agentsMdPath);
      console.log('  Created AGENTS.md');
    }
  }

  // Copy test.html if it doesn't exist so each project can customize it locally
  const testHtmlPath = path.join(userDir, 'test.html');
  if (!fs.existsSync(testHtmlPath)) {
    const sourceTestHtmlPath = path.join(packageRoot, 'public', 'test.html');
    if (fs.existsSync(sourceTestHtmlPath)) {
      fs.copyFileSync(sourceTestHtmlPath, testHtmlPath);
      console.log('  Created test.html');
    }
  }

  // Save .rad-coder.json config for future no-arg runs
  const radCoderConfigPath = path.join(userDir, '.rad-coder.json');
  const savedConfig = {
    creativeId: config.creativeId,
    flowlineId: config.flowlineId,
    flowlineName: config.flowlineName,
    createdAt: fs.existsSync(radCoderConfigPath)
      ? JSON.parse(fs.readFileSync(radCoderConfigPath, 'utf-8')).createdAt
      : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(radCoderConfigPath, JSON.stringify(savedConfig, null, 2) + '\n', 'utf-8');
  if (isNewProject) {
    console.log('  Created .rad-coder.json');
  }

  // Start the server with pre-fetched config
  await startServer(config);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

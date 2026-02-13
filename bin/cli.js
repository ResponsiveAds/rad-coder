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

for (const arg of args) {
  if (arg.startsWith('--editor=')) {
    editorFlag = arg.split('=')[1];
  } else if (arg === '--no-editor') {
    noEditor = true;
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

const creativeId = extractCreativeId(input);

if (!creativeId) {
  console.log('Usage: npx rad-coder <creativeId or previewUrl> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --editor=<cmd>   Set code editor command (default: code)');
  console.log('  --no-editor      Don\'t auto-open code editor');
  console.log('');
  console.log('Examples:');
  console.log('  npx rad-coder 697b80fcc6e904025f5147a0');
  console.log('  npx rad-coder https://studio.responsiveads.com/creatives/697b80fcc6e904025f5147a0/preview');
  console.log('  npx rad-coder 697b80fcc6e904025f5147a0 --editor=cursor');
  process.exit(1);
}

async function main() {
  // Determine the target directory
  const cwd = process.cwd();
  const currentDirName = path.basename(cwd);
  let userDir;

  if (currentDirName === creativeId) {
    // Already in the correct folder
    userDir = cwd;
    console.log(`Using existing folder: ./${creativeId}`);
  } else {
    // Create or use a folder with the creative ID
    userDir = path.join(cwd, creativeId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir);
      console.log(`Created folder: ./${creativeId}`);
    } else {
      console.log(`Using existing folder: ./${creativeId}`);
    }
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
  if (hasCreativeCustomJs) {
    if (!customJsExists) {
      // custom.js doesn't exist - ask user what to use
      const choice = await promptUser(
        'Found customJS in this creative. What would you like to use?',
        [
          'Use customJS from the creative (recommended)',
          'Start with blank template'
        ]
      );

      if (choice === 0) {
        // Use customjs from creative
        fs.writeFileSync(customJsPath, config.customjs, 'utf-8');
        console.log('  Created custom.js (from creative)');
      } else {
        // Use template
        const templatePath = path.join(packageRoot, 'templates', 'custom.js');
        if (fs.existsSync(templatePath)) {
          fs.copyFileSync(templatePath, customJsPath);
          console.log('  Created custom.js (from template)');
        }
      }
    } else {
      // custom.js exists - ask user if they want to overwrite
      const choice = await promptUser(
        'Found customJS in this creative. Your custom.js already exists.',
        [
          'Keep existing custom.js',
          'Overwrite with customJS from creative'
        ]
      );

      if (choice === 1) {
        // Overwrite with creative's customjs
        fs.writeFileSync(customJsPath, config.customjs, 'utf-8');
        console.log('  Overwrote custom.js with creative\'s customJS');
      } else {
        console.log('  Keeping existing custom.js');
      }
    }
  } else {
    // No customjs in creative - use template if custom.js doesn't exist
    if (!customJsExists) {
      const templatePath = path.join(packageRoot, 'templates', 'custom.js');
      if (fs.existsSync(templatePath)) {
        fs.copyFileSync(templatePath, customJsPath);
        console.log('  Created custom.js (from template)');
      }
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

  // Start the server with pre-fetched config
  await startServer(config);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const readline = require('readline');

// Get the package root directory
const packageRoot = path.join(__dirname, '..');

// Extract creative ID from input (can be a direct ID or a preview URL)
function extractCreativeId(input) {
  if (!input) return null;
  const urlMatch = input.match(/creatives\/([a-f0-9]+)/i);
  return urlMatch ? urlMatch[1] : input;
}

/**
 * Prompt user with a question and choices
 * @param {string} question - The question to ask
 * @param {string[]} choices - Array of choices
 * @returns {Promise<number>} - The index of the selected choice (0-based)
 */
function promptUser(question, choices) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log(`\n${question}`);
    choices.forEach((choice, index) => {
      console.log(`  [${index + 1}] ${choice}`);
    });

    const ask = () => {
      rl.question('\nChoice (enter number): ', (answer) => {
        const num = parseInt(answer, 10);
        if (num >= 1 && num <= choices.length) {
          rl.close();
          resolve(num - 1);
        } else {
          console.log(`Please enter a number between 1 and ${choices.length}`);
          ask();
        }
      });
    };

    ask();
  });
}

// Get creative ID from command line argument
const input = process.argv[2];
const creativeId = extractCreativeId(input);

if (!creativeId) {
  console.log('Usage: npx rad-coder <creativeId or previewUrl>');
  console.log('');
  console.log('Examples:');
  console.log('  npx rad-coder 697b80fcc6e904025f5147a0');
  console.log('  npx rad-coder https://studio.responsiveads.com/creatives/697b80fcc6e904025f5147a0/preview');
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

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

// Files to copy to user's directory on first run
const filesToCopy = [
  { template: 'custom.js', target: 'custom.js' },
  { template: 'AGENTS.md', target: 'AGENTS.md' }
];

// Copy template files if they don't exist
let filesCreated = false;
filesToCopy.forEach(({ template, target }) => {
  const targetPath = path.join(userDir, target);
  if (!fs.existsSync(targetPath)) {
    const templatePath = path.join(packageRoot, 'templates', template);
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, targetPath);
      console.log(`  Created ${target}`);
      filesCreated = true;
    }
  }
});

if (filesCreated) {
  console.log('');
}

// Set environment variables for the server
process.env.RAD_CODER_USER_DIR = userDir;
process.env.RAD_CODER_PACKAGE_DIR = packageRoot;

// Run the server
require('../server/index.js');

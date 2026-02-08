#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

// Get the package root directory
const packageRoot = path.join(__dirname, '..');

// Get user's current working directory
const userDir = process.cwd();

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
      console.log(` Created ${target}`);
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

#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const sync = require('../server/sync.js');

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
let noSyncCheckFlag = false;
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
  } else if (arg === '--no-sync-check') {
    noSyncCheckFlag = true;
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
  console.log('  --no-sync-check  Skip comparing local custom.js against Studio');
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

/**
 * Seed custom.js on a first run in this folder.
 * @returns {Promise<string>} 'creative' or 'template'
 */
async function seedCustomJs(userDir, customJsPath, remote, hasRemote) {
  if (hasRemote) {
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
      fs.writeFileSync(customJsPath, remote, 'utf-8');
      console.log('  Created custom.js (from creative)');
      return 'creative';
    }
  }

  const templatePath = path.join(packageRoot, 'templates', 'custom.js');
  if (fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, customJsPath);
    console.log('  Created custom.js (from template)');
  }
  return 'template';
}

function printDiff(userDir, local, remote) {
  console.log('');
  console.log(sync.renderDiff(userDir, local, remote, 'local-custom.js', 'studio-custom.js'));
  console.log('');
}

/**
 * Decide what the local custom.js should be, comparing it against the version
 * currently in Studio. See server/sync.js for why the comparison is three-way.
 *
 * @returns {Promise<{state: string, baseSource: string}>}
 */
async function resolveCustomJs(userDir, config) {
  const customJsPath = path.join(userDir, 'custom.js');
  const remote = config.customjs;
  const hasRemote = remote && remote.trim().length > 0;
  const local = sync.readLocal(userDir);

  // --reset: deliberately throw away local work and take Studio's version
  if (resetFlag && hasRemote) {
    const backup = sync.backupLocal(userDir);
    fs.writeFileSync(customJsPath, remote, 'utf-8');
    sync.writeBase(userDir, remote);
    sync.removeRemoteCopy(userDir);
    console.log('  Reset custom.js (from creative)');
    if (backup) {
      console.log(`  Previous local version saved to ${sync.relative(userDir, backup)}`);
    }
    return { state: 'in-sync', baseSource: 'studio' };
  }
  if (resetFlag && !hasRemote) {
    console.log('  --reset ignored: this creative has no custom JS in Studio');
  }

  // First run in this folder — nothing to compare against yet
  if (local === null) {
    const source = await seedCustomJs(userDir, customJsPath, remote, hasRemote);
    // The base records what Studio had at seed time, regardless of what we put
    // locally — so a later Studio edit reads as remote-ahead, not a conflict.
    sync.writeBase(userDir, remote || '');
    sync.archiveRemote(userDir, remote);
    return {
      state: source === 'creative' ? 'in-sync' : 'local-ahead',
      baseSource: 'studio'
    };
  }

  if (noSyncCheckFlag) {
    console.log('  Using existing custom.js (Studio sync check skipped)');
    return { state: 'skipped', baseSource: 'unchanged' };
  }

  const base = sync.readBase(userDir);
  const status = sync.classify({ local, remote, base });

  switch (status.state) {
    case 'in-sync':
      sync.writeBase(userDir, remote || '');
      sync.removeRemoteCopy(userDir);
      console.log('  ✓ custom.js is in sync with Studio');
      return { state: status.state, baseSource: 'studio' };

    case 'local-ahead':
      sync.removeRemoteCopy(userDir);
      if (!hasRemote) {
        console.log('  Using existing custom.js — Studio has no custom JS yet');
      } else {
        console.log(`  Using existing custom.js — local edits not in Studio yet (local vs Studio: ${sync.diffSummary(remote, local)})`);
      }
      console.log('    Studio is only updated when you paste custom.js into Creative → Settings → Custom JS');
      return { state: status.state, baseSource: 'unchanged' };

    case 'remote-ahead':
      return await resolveRemoteAhead(userDir, customJsPath, local, remote);

    case 'diverged':
    case 'unknown-divergence':
      return await resolveConflict(userDir, customJsPath, local, remote, status);

    default:
      return { state: status.state, baseSource: 'unchanged' };
  }
}

/**
 * Studio moved on and our local file has no unique work — pulling is lossless.
 */
async function resolveRemoteAhead(userDir, customJsPath, local, remote) {
  const archived = sync.archiveRemote(userDir, remote);
  const hasRemote = remote && remote.trim().length > 0;

  console.log('');
  console.log('  ↓ Studio has a NEWER custom JS than your local copy.');
  console.log(`    Your local custom.js has no changes of its own (${hasRemote ? `Studio vs local: ${sync.diffSummary(local, remote)}` : 'Studio cleared its custom JS'})`);
  if (archived) {
    console.log(`    Studio version archived to ${sync.relative(userDir, archived)}`);
  }

  let choice = 0;
  if (!noUiFlag) {
    while (true) {
      choice = await promptUser('Studio was updated. What would you like to use?', [
        'Use the Studio version (recommended)',
        'Keep my local custom.js',
        'Show the differences'
      ]);
      if (choice !== 2) break;
      printDiff(userDir, local, remote);
    }
  }

  if (choice === 1) {
    // Explicit decision to stay behind — record it so we stop nagging.
    sync.writeBase(userDir, remote || '');
    console.log('  Keeping local custom.js (Studio version left untouched)');
    return { state: 'local-ahead', baseSource: 'local-decision' };
  }

  const backup = sync.backupLocal(userDir);
  fs.writeFileSync(customJsPath, remote || '', 'utf-8');
  sync.writeBase(userDir, remote || '');
  sync.removeRemoteCopy(userDir);
  console.log('  ↓ Pulled the newer custom.js from Studio');
  if (backup) {
    console.log(`    Previous local version saved to ${sync.relative(userDir, backup)}`);
  }
  return { state: 'in-sync', baseSource: 'studio' };
}

/**
 * Both sides changed (or we have no base to tell). Never overwrite anything
 * without an explicit decision — this is the case that loses people's work.
 */
async function resolveConflict(userDir, customJsPath, local, remote, status) {
  const archived = sync.archiveRemote(userDir, remote);
  const remoteCopy = sync.writeRemoteCopy(userDir, remote);
  const unknown = status.state === 'unknown-divergence';

  console.log('');
  console.log('  ⚠⚠⚠  CONFLICT — your local custom.js and the Studio version differ');
  if (unknown) {
    console.log('        and there is no sync history for this folder, so it is');
    console.log('        impossible to tell which side is newer.');
  } else {
    console.log('        and BOTH have changed since they last matched.');
    console.log('        Someone edited this creative\'s custom JS in Studio.');
  }
  console.log('');
  console.log(`        Studio version  → ${sync.relative(userDir, remoteCopy)}`);
  if (archived) {
    console.log(`        archived copy   → ${sync.relative(userDir, archived)}`);
  }
  console.log(`        Studio vs local → ${sync.diffSummary(local, remote)}`);
  console.log('');

  if (noUiFlag) {
    console.log('        ► Using your LOCAL custom.js.');
    console.log('        ► Do NOT paste it into Studio before diffing against custom.remote.js —');
    console.log('          you would overwrite whatever was added there.');
    console.log('');
    // Base is deliberately left alone: the warning must repeat until a human resolves it.
    return { state: status.state, baseSource: 'unchanged' };
  }

  while (true) {
    const choice = await promptUser('How do you want to resolve this?', [
      'Keep my local custom.js (Studio version stays in custom.remote.js)',
      'Show the differences',
      'Overwrite my local custom.js with the Studio version'
    ]);

    if (choice === 1) {
      printDiff(userDir, local, remote);
      continue;
    }

    if (choice === 2) {
      const backup = sync.backupLocal(userDir);
      fs.writeFileSync(customJsPath, remote || '', 'utf-8');
      sync.writeBase(userDir, remote || '');
      sync.removeRemoteCopy(userDir);
      console.log('  Local custom.js replaced with the Studio version');
      if (backup) {
        console.log(`    Your previous version saved to ${sync.relative(userDir, backup)}`);
      }
      return { state: 'in-sync', baseSource: 'studio' };
    }

    // Keep local, but merge the two by hand later — remote copy stays on disk.
    sync.writeBase(userDir, remote || '');
    console.log('  Keeping your local custom.js');
    console.log(`    Merge anything you still need from ${sync.relative(userDir, remoteCopy)} before pasting into Studio`);
    return { state: 'local-ahead', baseSource: 'local-decision' };
  }
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

  // Handle --fresh: delete folder and recreate, but keep the archive of Studio
  // versions — that is a record of what the creative contained, not local scratch,
  // and it is the only way to recover a custom JS that was lost in Studio.
  if (freshFlag && fs.existsSync(userDir)) {
    const preserved = sync.takeHistory(userDir);
    fs.rmSync(userDir, { recursive: true, force: true });
    fs.mkdirSync(userDir);
    isNewProject = true;
    console.log(`  Fresh start: deleted and recreated ./${creativeId}`);
    const restored = sync.restoreHistory(userDir, preserved);
    if (restored > 0) {
      console.log(`  Kept ${restored} archived Studio version(s) in ${sync.SYNC_DIR}/history`);
    }
  }

  // Set environment variables for the server
  process.env.RAD_CODER_USER_DIR = userDir;
  process.env.RAD_CODER_PACKAGE_DIR = packageRoot;

  // Import server module to fetch creative config
  const { fetchCreativeConfig, startServer } = require('../server/index.js');

  // Fetch creative config first to check for customjs
  const config = await fetchCreativeConfig(creativeId);

  // Compare local custom.js against the version in Studio before using either
  const syncResult = await resolveCustomJs(userDir, config);

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
  let previousConfig = {};
  try {
    previousConfig = JSON.parse(fs.readFileSync(radCoderConfigPath, 'utf-8'));
  } catch (_) { /* missing or malformed — start fresh */ }

  const savedConfig = {
    creativeId: config.creativeId,
    flowlineId: config.flowlineId,
    flowlineName: config.flowlineName,
    createdAt: previousConfig.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sync: {
      state: syncResult.state,
      baseHash: sync.hash(sync.readBase(userDir)),
      baseSource: syncResult.baseSource === 'unchanged'
        ? (previousConfig.sync && previousConfig.sync.baseSource) || 'studio'
        : syncResult.baseSource,
      localHash: sync.hash(sync.readLocal(userDir)),
      studioHash: sync.hash(config.customjs),
      studioCheckedAt: new Date().toISOString()
    }
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

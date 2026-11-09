#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const sync = require('../server/sync.js');
const formats = require('../server/formats.js');

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
let flowlineFlag = null;
let pageFlag = null;
let newPageFlag = null;

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
  } else if (arg.startsWith('--flowline=')) {
    flowlineFlag = arg.slice('--flowline='.length);
  } else if (arg.startsWith('--page=')) {
    pageFlag = arg.slice('--page='.length);
  } else if (arg.startsWith('--new-page=')) {
    newPageFlag = arg.slice('--new-page='.length);
    if (!/^[\w.-]+$/.test(newPageFlag.replace(/\.html$/, ''))) {
      console.error(`Invalid --new-page name: ${newPageFlag}. Use letters, numbers, dots, dashes and underscores.`);
      process.exit(1);
    }
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
  console.log('  --reset          Overwrite local custom.js and format.js with the Studio versions');
  console.log('  --fresh          Delete local folder and start from scratch');
  console.log('  --no-sync-check  Skip comparing local custom.js / format.js against Studio');
  console.log('  --flowline=<x>   Start on this flowline (id, or part of its name)');
  console.log('  --page=<name>    Open a client test page from pages/ instead of test.html');
  console.log('  --new-page=<n>   Create pages/<n>.html from the client page template and open it');
  console.log('');
  console.log('Examples:');
  console.log('  npx rad-coder 697b80fcc6e904025f5147a0');
  console.log('  npx rad-coder https://studio.responsiveads.com/creatives/697b80fcc6e904025f5147a0/preview');
  console.log('  npx rad-coder 697b80fcc6e904025f5147a0 --editor=cursor');
  console.log('  npx rad-coder 697b80fcc6e904025f5147a0 --port=3100 --no-ui');
  console.log('  npx rad-coder 697b80fcc6e904025f5147a0 --flowline=sidebar --page=autotrader');
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

// What each kind of code is called, for messages
const LABELS = {
  custom: { file: 'custom.js', what: 'custom JS', remote: 'custom.remote.js' },
  format: { file: 'format.js', what: 'format JS', remote: 'format.remote.js' },
};

function printDiff(userDir, local, remote, kind = 'custom') {
  const { file } = LABELS[kind];
  console.log('');
  console.log(sync.renderDiff(userDir, local, remote, `local-${file}`, `studio-${file}`));
  console.log('');
}

/**
 * Seed format.js on a first run: the owner flowline's format JS from Studio.
 * Nothing is created when Studio has none — format.js is only for formats that
 * need code, and an empty file would only be confusing.
 * @returns {string} 'creative' or 'none'
 */
function seedFormatJs(userDir, remote, ownerName) {
  if (!remote || !remote.trim()) return 'none';
  fs.writeFileSync(path.join(userDir, 'format.js'), remote, 'utf-8');
  console.log(`  Created format.js (format JS of flowline "${ownerName}" from Studio)`);
  return 'creative';
}

/**
 * Decide what a local file (custom.js or format.js) should be, comparing it
 * against the version currently in Studio. See server/sync.js for why the
 * comparison is three-way.
 *
 * @param {'custom'|'format'} kind
 * @param {string} userDir
 * @param {?string} remote  Studio's current version
 * @param {Function} seed   creates the file on a first run; returns 'creative' | 'template' | 'none'
 * @returns {Promise<{state: string, baseSource: string}>}
 */
async function resolveCode(kind, userDir, remote, seed) {
  const L = LABELS[kind];
  const filePath = path.join(userDir, L.file);
  const hasRemote = remote && remote.trim().length > 0;
  const local = sync.readLocal(userDir, kind);

  // --reset: deliberately throw away local work and take Studio's version
  if (resetFlag && hasRemote) {
    const backup = sync.backupLocal(userDir, kind);
    fs.writeFileSync(filePath, remote, 'utf-8');
    sync.writeBase(userDir, remote, kind);
    sync.removeRemoteCopy(userDir, kind);
    console.log(`  Reset ${L.file} (from Studio)`);
    if (backup) {
      console.log(`  Previous local version saved to ${sync.relative(userDir, backup)}`);
    }
    return { state: 'in-sync', baseSource: 'studio' };
  }
  if (resetFlag && !hasRemote && (kind === 'custom' || local !== null)) {
    console.log(`  --reset ignored for ${L.file}: this creative has no ${L.what} in Studio`);
  }

  // First run in this folder — nothing to compare against yet
  if (local === null) {
    const source = await seed();
    if (source === 'none') return { state: 'none', baseSource: 'unchanged' };
    // The base records what Studio had at seed time, regardless of what we put
    // locally — so a later Studio edit reads as remote-ahead, not a conflict.
    sync.writeBase(userDir, remote || '', kind);
    sync.archiveRemote(userDir, remote, kind);
    return {
      state: source === 'creative' ? 'in-sync' : 'local-ahead',
      baseSource: 'studio'
    };
  }

  if (noSyncCheckFlag) {
    console.log(`  Using existing ${L.file} (Studio sync check skipped)`);
    return { state: 'skipped', baseSource: 'unchanged' };
  }

  const base = sync.readBase(userDir, kind);
  const status = sync.classify({ local, remote, base });

  switch (status.state) {
    case 'in-sync':
      sync.writeBase(userDir, remote || '', kind);
      sync.removeRemoteCopy(userDir, kind);
      console.log(`  ✓ ${L.file} is in sync with Studio`);
      return { state: status.state, baseSource: 'studio' };

    case 'local-ahead':
      sync.removeRemoteCopy(userDir, kind);
      if (!hasRemote) {
        console.log(`  Using existing ${L.file} — Studio has no ${L.what} yet`);
      } else {
        console.log(`  Using existing ${L.file} — local edits not in Studio yet (local vs Studio: ${sync.diffSummary(remote, local)})`);
      }
      console.log(`    Studio is only updated when you paste ${L.file} into ${sync.kindInfo(kind).studioField}`);
      return { state: status.state, baseSource: 'unchanged' };

    case 'remote-ahead':
      return await resolveRemoteAhead(kind, userDir, filePath, local, remote);

    case 'diverged':
    case 'unknown-divergence':
      return await resolveConflict(kind, userDir, filePath, local, remote, status);

    default:
      return { state: status.state, baseSource: 'unchanged' };
  }
}

/**
 * Studio moved on and our local file has no unique work — pulling is lossless.
 */
async function resolveRemoteAhead(kind, userDir, filePath, local, remote) {
  const L = LABELS[kind];
  const archived = sync.archiveRemote(userDir, remote, kind);
  const hasRemote = remote && remote.trim().length > 0;

  console.log('');
  console.log(`  ↓ Studio has a NEWER ${L.what} than your local ${L.file}.`);
  console.log(`    Your local ${L.file} has no changes of its own (${hasRemote ? `Studio vs local: ${sync.diffSummary(local, remote)}` : `Studio cleared its ${L.what}`})`);
  if (archived) {
    console.log(`    Studio version archived to ${sync.relative(userDir, archived)}`);
  }

  let choice = 0;
  if (!noUiFlag) {
    while (true) {
      choice = await promptUser(`Studio was updated (${L.what}). What would you like to use?`, [
        'Use the Studio version (recommended)',
        `Keep my local ${L.file}`,
        'Show the differences'
      ]);
      if (choice !== 2) break;
      printDiff(userDir, local, remote, kind);
    }
  }

  if (choice === 1) {
    // Explicit decision to stay behind — record it so we stop nagging.
    sync.writeBase(userDir, remote || '', kind);
    console.log(`  Keeping local ${L.file} (Studio version left untouched)`);
    return { state: 'local-ahead', baseSource: 'local-decision' };
  }

  const backup = sync.backupLocal(userDir, kind);
  fs.writeFileSync(filePath, remote || '', 'utf-8');
  sync.writeBase(userDir, remote || '', kind);
  sync.removeRemoteCopy(userDir, kind);
  console.log(`  ↓ Pulled the newer ${L.file} from Studio`);
  if (backup) {
    console.log(`    Previous local version saved to ${sync.relative(userDir, backup)}`);
  }
  return { state: 'in-sync', baseSource: 'studio' };
}

/**
 * Both sides changed (or we have no base to tell). Never overwrite anything
 * without an explicit decision — this is the case that loses people's work.
 */
async function resolveConflict(kind, userDir, filePath, local, remote, status) {
  const L = LABELS[kind];
  const archived = sync.archiveRemote(userDir, remote, kind);
  const remoteCopy = sync.writeRemoteCopy(userDir, remote, kind);
  const unknown = status.state === 'unknown-divergence';

  console.log('');
  console.log(`  ⚠⚠⚠  CONFLICT — your local ${L.file} and the Studio version differ`);
  if (unknown) {
    console.log('        and there is no sync history for this folder, so it is');
    console.log('        impossible to tell which side is newer.');
  } else {
    console.log('        and BOTH have changed since they last matched.');
    console.log(`        Someone edited this creative's ${L.what} in Studio.`);
  }
  console.log('');
  console.log(`        Studio version  → ${sync.relative(userDir, remoteCopy)}`);
  if (archived) {
    console.log(`        archived copy   → ${sync.relative(userDir, archived)}`);
  }
  console.log(`        Studio vs local → ${sync.diffSummary(local, remote)}`);
  console.log('');

  if (noUiFlag) {
    console.log(`        ► Using your LOCAL ${L.file}.`);
    console.log(`        ► Do NOT paste it into Studio before diffing against ${L.remote} —`);
    console.log('          you would overwrite whatever was added there.');
    console.log('');
    // Base is deliberately left alone: the warning must repeat until a human resolves it.
    return { state: status.state, baseSource: 'unchanged' };
  }

  while (true) {
    const choice = await promptUser(`How do you want to resolve this (${L.file})?`, [
      `Keep my local ${L.file} (Studio version stays in ${L.remote})`,
      'Show the differences',
      `Overwrite my local ${L.file} with the Studio version`
    ]);

    if (choice === 1) {
      printDiff(userDir, local, remote, kind);
      continue;
    }

    if (choice === 2) {
      const backup = sync.backupLocal(userDir, kind);
      fs.writeFileSync(filePath, remote || '', 'utf-8');
      sync.writeBase(userDir, remote || '', kind);
      sync.removeRemoteCopy(userDir, kind);
      console.log(`  Local ${L.file} replaced with the Studio version`);
      if (backup) {
        console.log(`    Your previous version saved to ${sync.relative(userDir, backup)}`);
      }
      return { state: 'in-sync', baseSource: 'studio' };
    }

    // Keep local, but merge the two by hand later — remote copy stays on disk.
    sync.writeBase(userDir, remote || '', kind);
    console.log(`  Keeping your local ${L.file}`);
    console.log(`    Merge anything you still need from ${sync.relative(userDir, remoteCopy)} before pasting into Studio`);
    return { state: 'local-ahead', baseSource: 'local-decision' };
  }
}

/**
 * Which flowline format.js belongs to (see server/formats.js):
 * the one recorded last time, else picked from Studio, else — when a format.js
 * already exists without any format JS in Studio — the selected flowline.
 */
function resolveFormatOwner(userDir, config, previousConfig) {
  const ids = config.allFlowlines.map(f => f.id);
  const previous = previousConfig.format && previousConfig.format.flowlineId;
  if (previous && ids.includes(previous)) return previous;
  const picked = formats.pickOwner(ids, config.formats || {}, config.flowlineId);
  if (picked) return picked;
  return fs.existsSync(path.join(userDir, 'format.js')) ? config.flowlineId : null;
}

/** pages/<name>.html for --page / --new-page values like "x", "x.html", "pages/x.html" */
function pageFileName(value) {
  let name = String(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^pages\//, '');
  if (!name.endsWith('.html')) name += '.html';
  return name;
}

/** Keep pages/ out of a --fresh wipe: they are hand-built and slow to remake */
function takePages(userDir) {
  const pagesDir = path.join(userDir, 'pages');
  if (!fs.existsSync(pagesDir)) return null;
  const keep = `${userDir}.pages-${process.pid}`;
  fs.renameSync(pagesDir, keep);
  return keep;
}

function restorePages(userDir, kept) {
  if (!kept) return false;
  fs.renameSync(kept, path.join(userDir, 'pages'));
  return true;
}

/**
 * Keep the project's AGENTS.md on the current rad-coder guide. A copy nobody edited
 * is replaced when rad-coder ships a newer guide (the old one is backed up); an
 * edited copy is left alone.
 * @returns {{hash: ?string, templateHash: ?string}} what to record in .rad-coder.json
 */
function syncAgentsMd(userDir, previousConfig) {
  const agentsMdPath = path.join(userDir, 'AGENTS.md');
  const templatePath = path.join(packageRoot, 'templates', 'AGENTS.md');
  if (!fs.existsSync(templatePath)) return previousConfig.agentsMd || null;
  const template = fs.readFileSync(templatePath, 'utf-8');
  const templateHash = sync.hash(template);
  const previous = previousConfig.agentsMd || {};

  if (!fs.existsSync(agentsMdPath)) {
    fs.writeFileSync(agentsMdPath, template, 'utf-8');
    console.log('  Created AGENTS.md');
    return { hash: templateHash, templateHash };
  }

  const current = fs.readFileSync(agentsMdPath, 'utf-8');
  const currentHash = sync.hash(current);
  if (currentHash === templateHash) return { hash: templateHash, templateHash };

  // Unedited copy of an older guide: recorded by a previous run, or (before
  // rad-coder recorded it) an old guide without the format JS section
  const unedited = previous.hash
    ? currentHash === previous.hash
    : current.startsWith('# RAD Agents Guide') && !current.includes('# Format JS and client test pages');
  if (unedited) {
    const dir = path.join(userDir, sync.SYNC_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const backup = path.join(dir, `AGENTS-${new Date().toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')}.md`);
    fs.writeFileSync(backup, current, 'utf-8');
    fs.writeFileSync(agentsMdPath, template, 'utf-8');
    console.log(`  Updated AGENTS.md to the current rad-coder guide (old copy: ${sync.relative(userDir, backup)})`);
    return { hash: templateHash, templateHash };
  }

  if (previous.templateHash !== templateHash) {
    console.log('  AGENTS.md has your own edits, so it was kept. rad-coder has a newer guide:');
    console.log('    delete AGENTS.md (or merge by hand) to get it');
  }
  return { hash: previous.hash || null, templateHash };
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
  // and it is the only way to recover code that was lost in Studio. Client test
  // pages are kept too: they are hand-built and slow to remake.
  if (freshFlag && fs.existsSync(userDir)) {
    const preserved = sync.takeHistory(userDir, 'custom');
    const preservedFormat = sync.takeHistory(userDir, 'format');
    const keptPages = takePages(userDir);
    fs.rmSync(userDir, { recursive: true, force: true });
    fs.mkdirSync(userDir);
    isNewProject = true;
    console.log(`  Fresh start: deleted and recreated ./${creativeId}`);
    const restored = sync.restoreHistory(userDir, preserved, 'custom') + sync.restoreHistory(userDir, preservedFormat, 'format');
    if (restored > 0) {
      console.log(`  Kept ${restored} archived Studio version(s) in ${sync.SYNC_DIR}/`);
    }
    if (restorePages(userDir, keptPages)) {
      console.log('  Kept pages/ (client test pages)');
    }
  }

  // Set environment variables for the server
  process.env.RAD_CODER_USER_DIR = userDir;
  process.env.RAD_CODER_PACKAGE_DIR = packageRoot;

  // Import server module to fetch creative config
  const { fetchCreativeConfig, selectFlowline, startServer } = require('../server/index.js');

  // Fetch creative config first to check for customjs
  const config = await fetchCreativeConfig(creativeId);

  if (flowlineFlag) {
    const fl = selectFlowline(config, flowlineFlag);
    if (!fl) {
      console.error(`\n No flowline matches --flowline=${flowlineFlag}. This creative has:`);
      config.allFlowlines.forEach((f) => console.error(`   ${f.id}  ${f.name}`));
      process.exit(1);
    }
    console.log(`  Flowline: ${fl.name}`);
  }

  const radCoderConfigPath = path.join(userDir, '.rad-coder.json');
  let previousConfig = {};
  try {
    previousConfig = JSON.parse(fs.readFileSync(radCoderConfigPath, 'utf-8'));
  } catch (_) { /* missing or malformed — start fresh */ }

  // Compare local custom.js against the version in Studio before using either
  const syncResult = await resolveCode('custom', userDir, config.customjs,
    () => seedCustomJs(userDir, path.join(userDir, 'custom.js'), config.customjs, !!(config.customjs && config.customjs.trim())));

  // Same for format.js — the format JS of one flowline (see server/formats.js)
  let formatResult = null;
  const ownerId = resolveFormatOwner(userDir, config, previousConfig);
  if (ownerId) {
    const owner = config.allFlowlines.find(f => f.id === ownerId);
    const ids = config.allFlowlines.map(f => f.id);
    config.format = {
      flowlineId: owner.id,
      flowlineName: owner.name,
      appliesTo: formats.appliesTo(owner.id, ids, config.formats || {}),
      isCreativeSpecific: owner.isCreativeSpecific !== false,
    };
    const remoteFormat = (config.formats || {})[owner.id] || null;
    formatResult = await resolveCode('format', userDir, remoteFormat, () => seedFormatJs(userDir, remoteFormat, owner.name));
    if (formatResult.state === 'none' && !fs.existsSync(path.join(userDir, 'format.js'))) {
      config.format = null;
      formatResult = null;
    } else if (!config.format.isCreativeSpecific) {
      console.log('  ⚠ format.js belongs to a format SHARED with other creatives —');
      console.log('    pasting it into Studio (Format → Custom JS) changes every creative that uses it');
    }
  }

  // Agent guide: AGENTS.md (read by Codex, Copilot, Cursor…) plus a CLAUDE.md that
  // imports it, because Claude Code only reads CLAUDE.md
  const agentsMd = syncAgentsMd(userDir, previousConfig);
  const claudeMdPath = path.join(userDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, '@AGENTS.md\n', 'utf-8');
    console.log('  Created CLAUDE.md (loads AGENTS.md for Claude Code)');
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

  // Client test pages: --new-page creates one from the template, --page opens one
  if (newPageFlag) {
    const name = pageFileName(newPageFlag);
    const pagePath = path.join(userDir, 'pages', name);
    if (fs.existsSync(pagePath)) {
      console.log(`  pages/${name} already exists — opening it`);
    } else {
      fs.mkdirSync(path.dirname(pagePath), { recursive: true });
      fs.copyFileSync(path.join(packageRoot, 'templates', 'page.html'), pagePath);
      console.log(`  Created pages/${name} (client test page template)`);
    }
    process.env.RAD_CODER_OPEN_PATH = `/pages/${encodeURIComponent(name)}`;
  } else if (pageFlag) {
    const name = pageFileName(pageFlag);
    if (fs.existsSync(path.join(userDir, 'pages', name))) {
      process.env.RAD_CODER_OPEN_PATH = `/pages/${encodeURIComponent(name)}`;
    } else {
      console.log(`  ⚠ pages/${name} not found — opening test.html instead`);
    }
  }

  // Save .rad-coder.json config for future no-arg runs
  const syncRecord = (kind, result, studioCode, previous) => ({
    state: result.state,
    baseHash: sync.hash(sync.readBase(userDir, kind)),
    baseSource: result.baseSource === 'unchanged'
      ? (previous && previous.baseSource) || 'studio'
      : result.baseSource,
    localHash: sync.hash(sync.readLocal(userDir, kind)),
    studioHash: sync.hash(studioCode),
    studioCheckedAt: new Date().toISOString()
  });

  const savedConfig = {
    creativeId: config.creativeId,
    flowlineId: config.flowlineId,
    flowlineName: config.flowlineName,
    createdAt: previousConfig.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    agentsMd,
    sync: syncRecord('custom', syncResult, config.customjs, previousConfig.sync),
    format: config.format
      ? {
        ...config.format,
        sync: syncRecord('format', formatResult, (config.formats || {})[config.format.flowlineId],
          previousConfig.format && previousConfig.format.sync),
      }
      : null
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

/**
 * Studio ↔ local custom.js sync tracking
 *
 * The creative's custom JS lives in two independently editable places:
 *   - Studio (window.creative.config.customjs), edited in the browser by anyone
 *   - the local custom.js in a rad-coder project folder
 *
 * There is no write API, so pushing local code to Studio is manual copy-paste.
 * That makes a stale local copy dangerous: pasting it over a Studio version
 * somebody else changed silently destroys their work.
 *
 * To tell "I have unpushed edits" apart from "someone changed Studio", we keep a
 * *base*: the Studio content as of the last time the two sides were known to
 * agree. Comparing local/remote/base gives an unambiguous state (see classify).
 *
 * State lives in a `.rad-coder/` folder next to custom.js:
 *   base.js              the base snapshot
 *   history/<ISO>.js     every distinct Studio version we ever observed
 *   backups/custom-*.js  local custom.js, saved before any overwrite
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SYNC_DIR = '.rad-coder';
const MAX_HISTORY = 50;
const MAX_BACKUPS = 20;

// ============================================================
// Comparison
// ============================================================

/**
 * Normalize code before comparing. Studio round-trips line endings and trailing
 * whitespace, so a raw string compare would report phantom conflicts.
 */
function normalize(code) {
  return String(code == null ? '' : code)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** Short content fingerprint of the normalized code */
function hash(code) {
  const normalized = normalize(code);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
}

function sameCode(a, b) {
  return normalize(a) === normalize(b);
}

/**
 * Work out where local and remote stand relative to each other and the base.
 *
 * @param {Object} arg
 * @param {string|null} arg.local  contents of custom.js
 * @param {string|null} arg.remote contents of Studio's customjs
 * @param {string|null} arg.base   contents of .rad-coder/base.js
 * @returns {{state: string, localHash: ?string, remoteHash: ?string, baseHash: ?string}}
 *
 * States:
 *   no-local            no custom.js yet (first run)
 *   no-remote           Studio has no custom JS at all
 *   in-sync             local matches Studio
 *   local-ahead         your unpushed edits; Studio unchanged since base
 *   remote-ahead        Studio was edited; you changed nothing since base
 *   diverged            both sides changed since base — the dangerous case
 *   unknown-divergence  sides differ and there is no base to reason from
 */
function classify({ local, remote, base }) {
  const result = {
    state: 'in-sync',
    localHash: hash(local),
    remoteHash: hash(remote),
    baseHash: hash(base),
  };

  const hasLocal = normalize(local).length > 0;
  const hasRemote = normalize(remote).length > 0;

  if (!hasLocal) {
    result.state = 'no-local';
    return result;
  }

  if (sameCode(local, remote)) {
    result.state = 'in-sync';
    return result;
  }

  if (!hasRemote) {
    // Studio has no custom JS. Normally that just means our local work was
    // never pasted in. But if the base says Studio used to have code and we
    // have not touched ours, someone cleared it — worth surfacing.
    const clearedInStudio = normalize(base).length > 0 && sameCode(local, base);
    result.state = clearedInStudio ? 'remote-ahead' : 'local-ahead';
    return result;
  }

  if (base == null) {
    result.state = 'unknown-divergence';
    return result;
  }

  const remoteMovedAwayFromBase = !sameCode(remote, base);
  const localMovedAwayFromBase = !sameCode(local, base);

  if (!remoteMovedAwayFromBase) {
    result.state = 'local-ahead';
  } else if (!localMovedAwayFromBase) {
    result.state = 'remote-ahead';
  } else {
    result.state = 'diverged';
  }

  return result;
}

// ============================================================
// Diffing
// ============================================================

function lines(code) {
  return normalize(code).split('\n');
}

/**
 * Cheap change summary for one-line messages.
 * @returns {{added: number, removed: number, firstChangedLine: ?number}}
 */
function diffStats(a, b) {
  const from = lines(a);
  const to = lines(b);

  let head = 0;
  while (head < from.length && head < to.length && from[head] === to[head]) head++;

  let tail = 0;
  while (
    tail < from.length - head
    && tail < to.length - head
    && from[from.length - 1 - tail] === to[to.length - 1 - tail]
  ) tail++;

  const removed = from.length - head - tail;
  const added = to.length - head - tail;

  return {
    added: Math.max(0, added),
    removed: Math.max(0, removed),
    firstChangedLine: (added > 0 || removed > 0) ? head + 1 : null,
  };
}

/** One-line human summary, e.g. "+12 / -3 lines, first change at line 47" */
function diffSummary(a, b) {
  const { added, removed, firstChangedLine } = diffStats(a, b);
  if (!added && !removed) return 'no line differences (whitespace only)';
  const at = firstChangedLine ? `, first change at line ${firstChangedLine}` : '';
  return `+${added} / -${removed} lines${at}`;
}

/**
 * Render a readable diff. Prefers `git diff --no-index`; falls back to a plain
 * changed-block listing when git is unavailable.
 * @returns {string}
 */
function renderDiff(userDir, aCode, bCode, aLabel = 'local', bLabel = 'studio') {
  const tmpDir = path.join(userDir, SYNC_DIR, 'tmp');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Names without a directory keep git's diff header short and readable
    const aName = aLabel.endsWith('.js') ? aLabel : `${aLabel}.js`;
    const bName = bLabel.endsWith('.js') ? bLabel : `${bLabel}.js`;
    fs.writeFileSync(path.join(tmpDir, aName), normalize(aCode) + '\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, bName), normalize(bCode) + '\n', 'utf-8');

    try {
      execFileSync('git', ['diff', '--no-index', '--unified=3', '--', aName, bName], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return '(no differences)';
    } catch (err) {
      // git diff exits 1 when files differ — that is the success path here
      if (err && typeof err.stdout === 'string' && err.stdout.length > 0) {
        return err.stdout;
      }
      throw err;
    }
  } catch (_) {
    return fallbackDiff(aCode, bCode, aLabel, bLabel);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) { /* best effort */ }
  }
}

function fallbackDiff(aCode, bCode, aLabel, bLabel) {
  const from = lines(aCode);
  const to = lines(bCode);
  const { added, removed, firstChangedLine } = diffStats(aCode, bCode);

  if (!added && !removed) return '(no differences)';

  const head = (firstChangedLine || 1) - 1;
  const out = [`--- ${aLabel}`, `+++ ${bLabel}`, `@@ line ${head + 1} @@`];
  for (let i = head; i < head + removed; i++) out.push(`- ${from[i]}`);
  for (let i = head; i < head + added; i++) out.push(`+ ${to[i]}`);
  return out.join('\n');
}

// ============================================================
// State directory
// ============================================================

function syncDir(userDir) {
  return path.join(userDir, SYNC_DIR);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readFileOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (_) {
    return null;
  }
}

function readLocal(userDir) {
  return readFileOrNull(path.join(userDir, 'custom.js'));
}

function readBase(userDir) {
  return readFileOrNull(path.join(syncDir(userDir), 'base.js'));
}

/** Record the Studio content the two sides are now considered to agree on */
function writeBase(userDir, code) {
  const basePath = path.join(syncDir(userDir), 'base.js');
  ensureDir(syncDir(userDir));
  fs.writeFileSync(basePath, String(code == null ? '' : code), 'utf-8');
  return basePath;
}

/** File-name-safe ISO timestamp, e.g. 2026-08-27T09-14-02 */
function stamp() {
  return new Date().toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-');
}

function newestEntry(dir) {
  try {
    const entries = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();
    if (entries.length === 0) return null;
    return path.join(dir, entries[entries.length - 1]);
  } catch (_) {
    return null;
  }
}

function pruneDir(dir, keep) {
  try {
    const entries = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - keep))) {
      fs.rmSync(path.join(dir, stale), { force: true });
    }
  } catch (_) { /* best effort */ }
}

/**
 * Archive a Studio version, unless it is identical to the newest one already
 * archived. This is the safety net: every custom JS that ever existed in Studio
 * while rad-coder was watching stays recoverable on disk.
 * @returns {string|null} path written, or null if nothing to archive
 */
function archiveRemote(userDir, code) {
  if (normalize(code).length === 0) return null;

  const dir = ensureDir(path.join(syncDir(userDir), 'history'));
  const newest = newestEntry(dir);
  if (newest && sameCode(readFileOrNull(newest), code)) return null;

  const target = path.join(dir, `${stamp()}.js`);
  fs.writeFileSync(target, String(code), 'utf-8');
  pruneDir(dir, MAX_HISTORY);
  return target;
}

/**
 * Copy the current custom.js aside before it gets overwritten.
 * @returns {string|null} path written, or null if there was nothing to back up
 */
function backupLocal(userDir) {
  const local = readLocal(userDir);
  if (local == null) return null;

  const dir = ensureDir(path.join(syncDir(userDir), 'backups'));
  const target = path.join(dir, `custom-${stamp()}.js`);
  fs.writeFileSync(target, local, 'utf-8');
  pruneDir(dir, MAX_BACKUPS);
  return target;
}

/**
 * Read the whole Studio archive into memory so a caller about to wipe the
 * project folder (--fresh) can put it back afterwards. The archive records what
 * Studio contained, so it must survive a local reset.
 * @returns {Array<{name: string, code: string}>}
 */
function takeHistory(userDir) {
  const dir = path.join(syncDir(userDir), 'history');
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.js'))
      .sort()
      .map(name => ({ name, code: fs.readFileSync(path.join(dir, name), 'utf-8') }));
  } catch (_) {
    return [];
  }
}

/**
 * Put a previously taken archive back.
 * @returns {number} how many entries were restored
 */
function restoreHistory(userDir, entries) {
  if (!entries || entries.length === 0) return 0;
  const dir = ensureDir(path.join(syncDir(userDir), 'history'));
  for (const entry of entries) {
    fs.writeFileSync(path.join(dir, entry.name), entry.code, 'utf-8');
  }
  return entries.length;
}

/** Write the Studio version next to custom.js so both are visible in the editor */
function writeRemoteCopy(userDir, code) {
  const target = path.join(userDir, 'custom.remote.js');
  fs.writeFileSync(target, String(code == null ? '' : code), 'utf-8');
  return target;
}

function removeRemoteCopy(userDir) {
  try {
    fs.rmSync(path.join(userDir, 'custom.remote.js'), { force: true });
  } catch (_) { /* best effort */ }
}

/** Path relative to the project folder, for readable log messages */
function relative(userDir, filePath) {
  if (!filePath) return '';
  return path.relative(userDir, filePath) || filePath;
}

module.exports = {
  SYNC_DIR,
  normalize,
  hash,
  sameCode,
  classify,
  diffStats,
  diffSummary,
  renderDiff,
  readLocal,
  readBase,
  writeBase,
  archiveRemote,
  takeHistory,
  restoreHistory,
  backupLocal,
  writeRemoteCopy,
  removeRemoteCopy,
  relative,
};

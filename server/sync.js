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
 * The same applies to the format JS (Studio: Format → Custom JS), which rad-coder
 * keeps in format.js, and to the format CSS (Format → Custom CSS), kept in
 * format.css. Every function takes a `kind` ('custom' | 'format' | 'formatCss')
 * that picks the file set; it defaults to 'custom'.
 *
 * State lives in a `.rad-coder/` folder next to custom.js:
 *   base.js              the base snapshot of custom.js
 *   history/<ISO>.js     every distinct Studio custom JS we ever observed
 *   format/base.js       the base snapshot of format.js
 *   format/history/      every distinct Studio format JS we ever observed
 *   backups/custom-*.js  local custom.js, saved before any overwrite
 *   backups/format-*.js  local format.js, saved before any overwrite
 *   format-css/base.css  the base snapshot of format.css
 *   format-css/history/  every distinct Studio format CSS we ever observed
 *   backups/format-*.css local format.css, saved before any overwrite
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SYNC_DIR = '.rad-coder';
const MAX_HISTORY = 50;
const MAX_BACKUPS = 20;

// Where each kind of code lives, relative to the project folder
const KINDS = {
  custom: {
    file: 'custom.js',
    remote: 'custom.remote.js',
    base: path.join(SYNC_DIR, 'base.js'),
    history: path.join(SYNC_DIR, 'history'),
    backupPrefix: 'custom-',
    ext: '.js',
    studioField: 'Creative → Settings → Custom JS',
  },
  format: {
    file: 'format.js',
    remote: 'format.remote.js',
    base: path.join(SYNC_DIR, 'format', 'base.js'),
    history: path.join(SYNC_DIR, 'format', 'history'),
    backupPrefix: 'format-',
    ext: '.js',
    studioField: 'Format → Custom JS',
  },
  formatCss: {
    file: 'format.css',
    remote: 'format.remote.css',
    base: path.join(SYNC_DIR, 'format-css', 'base.css'),
    history: path.join(SYNC_DIR, 'format-css', 'history'),
    backupPrefix: 'format-',
    ext: '.css',
    studioField: 'Format → Custom CSS',
    // Studio hands CSS back with every double quote turned into a single one
    comparable: (code) => code.replace(/"/g, "'"),
  },
};

function kindInfo(kind = 'custom') {
  const info = KINDS[kind];
  if (!info) throw new Error(`Unknown code kind: ${kind}`);
  return info;
}

// ============================================================
// Comparison
// ============================================================

/**
 * Normalize code before comparing. Studio round-trips line endings and trailing
 * whitespace, so a raw string compare would report phantom conflicts.
 */
function normalize(code, kind = 'custom') {
  const { comparable } = kindInfo(kind);
  const text = String(code == null ? '' : code)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
  return comparable ? comparable(text) : text;
}

/** Short content fingerprint of the normalized code */
function hash(code, kind = 'custom') {
  const normalized = normalize(code, kind);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
}

function sameCode(a, b, kind = 'custom') {
  return normalize(a, kind) === normalize(b, kind);
}

/**
 * Work out where local and remote stand relative to each other and the base.
 *
 * @param {Object} arg
 * @param {string|null} arg.local  contents of custom.js
 * @param {string|null} arg.remote contents of Studio's customjs
 * @param {string|null} arg.base   contents of .rad-coder/base.js
 * @param {string} [arg.kind]      'custom' | 'format' | 'formatCss'
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
function classify({ local, remote, base, kind = 'custom' }) {
  const result = {
    state: 'in-sync',
    localHash: hash(local, kind),
    remoteHash: hash(remote, kind),
    baseHash: hash(base, kind),
  };

  const hasLocal = normalize(local, kind).length > 0;
  const hasRemote = normalize(remote, kind).length > 0;

  if (!hasLocal) {
    result.state = 'no-local';
    return result;
  }

  if (sameCode(local, remote, kind)) {
    result.state = 'in-sync';
    return result;
  }

  if (!hasRemote) {
    // Studio has no custom JS. Normally that just means our local work was
    // never pasted in. But if the base says Studio used to have code and we
    // have not touched ours, someone cleared it — worth surfacing.
    const clearedInStudio = normalize(base, kind).length > 0 && sameCode(local, base, kind);
    result.state = clearedInStudio ? 'remote-ahead' : 'local-ahead';
    return result;
  }

  if (base == null) {
    result.state = 'unknown-divergence';
    return result;
  }

  const remoteMovedAwayFromBase = !sameCode(remote, base, kind);
  const localMovedAwayFromBase = !sameCode(local, base, kind);

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

function lines(code, kind = 'custom') {
  return normalize(code, kind).split('\n');
}

/**
 * Cheap change summary for one-line messages.
 * @returns {{added: number, removed: number, firstChangedLine: ?number}}
 */
function diffStats(a, b, kind = 'custom') {
  const from = lines(a, kind);
  const to = lines(b, kind);

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
function diffSummary(a, b, kind = 'custom') {
  const { added, removed, firstChangedLine } = diffStats(a, b, kind);
  if (!added && !removed) return 'no line differences (whitespace only)';
  const at = firstChangedLine ? `, first change at line ${firstChangedLine}` : '';
  return `+${added} / -${removed} lines${at}`;
}

/**
 * Render a readable diff. Prefers `git diff --no-index`; falls back to a plain
 * changed-block listing when git is unavailable.
 * @returns {string}
 */
function renderDiff(userDir, aCode, bCode, aLabel = 'local', bLabel = 'studio', kind = 'custom') {
  const { ext } = kindInfo(kind);
  const tmpDir = path.join(userDir, SYNC_DIR, 'tmp');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Names without a directory keep git's diff header short and readable
    const aName = aLabel.endsWith(ext) ? aLabel : `${aLabel}${ext}`;
    const bName = bLabel.endsWith(ext) ? bLabel : `${bLabel}${ext}`;
    fs.writeFileSync(path.join(tmpDir, aName), normalize(aCode, kind) + '\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, bName), normalize(bCode, kind) + '\n', 'utf-8');

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
    return fallbackDiff(aCode, bCode, aLabel, bLabel, kind);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) { /* best effort */ }
  }
}

function fallbackDiff(aCode, bCode, aLabel, bLabel, kind = 'custom') {
  const from = lines(aCode, kind);
  const to = lines(bCode, kind);
  const { added, removed, firstChangedLine } = diffStats(aCode, bCode, kind);

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

function readLocal(userDir, kind = 'custom') {
  return readFileOrNull(path.join(userDir, kindInfo(kind).file));
}

function readBase(userDir, kind = 'custom') {
  return readFileOrNull(path.join(userDir, kindInfo(kind).base));
}

/** Record the Studio content the two sides are now considered to agree on */
function writeBase(userDir, code, kind = 'custom') {
  const basePath = path.join(userDir, kindInfo(kind).base);
  ensureDir(path.dirname(basePath));
  fs.writeFileSync(basePath, String(code == null ? '' : code), 'utf-8');
  return basePath;
}

/** File-name-safe ISO timestamp, e.g. 2026-08-27T09-14-02 */
function stamp() {
  return new Date().toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-');
}

function entries(dir, ext, prefix = '') {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith(ext) && f.startsWith(prefix)).sort();
  } catch (_) {
    return [];
  }
}

function newestEntry(dir, ext) {
  const found = entries(dir, ext);
  return found.length ? path.join(dir, found[found.length - 1]) : null;
}

function pruneDir(dir, keep, ext, prefix = '') {
  const found = entries(dir, ext, prefix);
  for (const stale of found.slice(0, Math.max(0, found.length - keep))) {
    try {
      fs.rmSync(path.join(dir, stale), { force: true });
    } catch (_) { /* best effort */ }
  }
}

/**
 * Archive a Studio version, unless it is identical to the newest one already
 * archived. This is the safety net: every custom JS that ever existed in Studio
 * while rad-coder was watching stays recoverable on disk.
 * @returns {string|null} path written, or null if nothing to archive
 */
function archiveRemote(userDir, code, kind = 'custom') {
  if (normalize(code, kind).length === 0) return null;

  const { history, ext } = kindInfo(kind);
  const dir = ensureDir(path.join(userDir, history));
  const newest = newestEntry(dir, ext);
  if (newest && sameCode(readFileOrNull(newest), code, kind)) return null;

  const target = path.join(dir, `${stamp()}${ext}`);
  fs.writeFileSync(target, String(code), 'utf-8');
  pruneDir(dir, MAX_HISTORY, ext);
  return target;
}

/**
 * Copy the current local file aside before it gets overwritten.
 * @returns {string|null} path written, or null if there was nothing to back up
 */
function backupLocal(userDir, kind = 'custom') {
  const local = readLocal(userDir, kind);
  if (local == null) return null;

  const { backupPrefix, ext } = kindInfo(kind);
  const dir = ensureDir(path.join(syncDir(userDir), 'backups'));
  const target = path.join(dir, `${backupPrefix}${stamp()}${ext}`);
  fs.writeFileSync(target, local, 'utf-8');
  pruneDir(dir, MAX_BACKUPS, ext, backupPrefix);
  return target;
}

/**
 * Read the whole Studio archive into memory so a caller about to wipe the
 * project folder (--fresh) can put it back afterwards. The archive records what
 * Studio contained, so it must survive a local reset.
 * @returns {Array<{name: string, code: string}>}
 */
function takeHistory(userDir, kind = 'custom') {
  const { history, ext } = kindInfo(kind);
  const dir = path.join(userDir, history);
  return entries(dir, ext).map(name => ({ name, code: fs.readFileSync(path.join(dir, name), 'utf-8') }));
}

/**
 * Put a previously taken archive back.
 * @returns {number} how many entries were restored
 */
function restoreHistory(userDir, entries, kind = 'custom') {
  if (!entries || entries.length === 0) return 0;
  const dir = ensureDir(path.join(userDir, kindInfo(kind).history));
  for (const entry of entries) {
    fs.writeFileSync(path.join(dir, entry.name), entry.code, 'utf-8');
  }
  return entries.length;
}

/** Write the Studio version next to the local file so both are visible in the editor */
function writeRemoteCopy(userDir, code, kind = 'custom') {
  const target = path.join(userDir, kindInfo(kind).remote);
  fs.writeFileSync(target, String(code == null ? '' : code), 'utf-8');
  return target;
}

function removeRemoteCopy(userDir, kind = 'custom') {
  try {
    fs.rmSync(path.join(userDir, kindInfo(kind).remote), { force: true });
  } catch (_) { /* best effort */ }
}

/** Path relative to the project folder, for readable log messages */
function relative(userDir, filePath) {
  if (!filePath) return '';
  return path.relative(userDir, filePath) || filePath;
}

module.exports = {
  SYNC_DIR,
  KINDS,
  kindInfo,
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

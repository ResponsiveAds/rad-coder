/**
 * Reading a creative out of Studio's public preview page
 *
 * There is no read API, so everything rad-coder knows about a creative comes from
 * the globals the preview page embeds:
 *   window.creative   the creative; config.customjs is the creative Custom JS
 *   window.flowlines  the creative's flowlines ("formats" in the Studio UI); each
 *                     flowline.customJS is that format's Custom JS ("format JS")
 *
 * Pure functions only (no side effects on require), so both the CLI and the dev
 * server can use them — and they can be tested against a saved preview page.
 */

const fs = require('fs');

function previewUrlFor(creativeId) {
  return `https://studio.responsiveads.com/creatives/${creativeId}/preview`;
}

/**
 * Extract a JSON value that follows `marker` in the HTML by balanced bracket
 * matching. Studio escapes single quotes as \' inside some globals, which is not
 * valid JSON, so those are unescaped before parsing.
 *
 * @param {string} html
 * @param {string} marker  e.g. 'window.creative = '
 * @returns {*} parsed value, or null when missing / unparsable
 */
function extractJsonValue(html, marker) {
  const at = html.indexOf(marker);
  if (at === -1) return null;

  let start = at + marker.length;
  while (start < html.length && html[start] !== '{' && html[start] !== '[') {
    if (!/\s/.test(html[start])) return null; // marker is not followed by an object/array literal
    start++;
  }
  const open = html[start];
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (char === '\\') { escapeNext = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === open) depth++;
    if (char === close) {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) return null;

  const raw = html.substring(start, end);
  try {
    return JSON.parse(raw);
  } catch (_) {
    try {
      return JSON.parse(raw.replace(/\\'/g, "'"));
    } catch (__) {
      return null;
    }
  }
}

/** The creative's Custom JS (Creative → Settings → Custom JS) */
function extractCustomJs(html) {
  const creative = extractJsonValue(html, 'window.creative = ');
  if (creative && creative.config && creative.config.customjs) {
    return creative.config.customjs;
  }
  return null;
}

function extractFlowlines(html) {
  // Older preview pages wrapped the array in a string literal
  const legacy = html.match(/var\s+flowlinesString\s*=\s*\('(\[[\s\S]*?\])'\)/);
  if (legacy) {
    try {
      return JSON.parse(legacy[1].replace(/\\'/g, "'"));
    } catch (_) { /* fall through to the current format */ }
  }
  const flowlines = extractJsonValue(html, 'window.flowlines = ');
  return Array.isArray(flowlines) ? flowlines : null;
}

/**
 * Format JS per flowline: { [flowlineId]: string|null }.
 * Studio stores it on the flowline definition as flowline.customJS.
 */
function formatsFromFlowlines(flowlines) {
  const formats = {};
  for (const fl of flowlines || []) {
    const id = fl._id || fl.id;
    const code = fl.flowline && typeof fl.flowline.customJS === 'string' ? fl.flowline.customJS : '';
    formats[id] = code.trim() ? code : null;
  }
  return formats;
}

/** Everything rad-coder reads from the preview page */
function parsePreview(html, creativeId) {
  const idMatch = html.match(/window\.creativeId\s*=\s*['"]([^'"]+)['"]/);
  const flowlines = extractFlowlines(html);
  return {
    creativeId: idMatch ? idMatch[1] : creativeId,
    customjs: extractCustomJs(html),
    flowlines,
    formats: formatsFromFlowlines(flowlines),
  };
}

/**
 * Re-read the code that can change in Studio while we work: the creative Custom
 * JS and every flowline's format JS. Never throws — it runs on a timer, and a
 * network blip must not kill a working session.
 *
 * Dev/testing seams, because there is no way to write to Studio:
 *   RAD_CODER_FAKE_REMOTE_JS      file to read as "Studio's" creative Custom JS
 *   RAD_CODER_FAKE_REMOTE_FORMAT  file to read as "Studio's" format JS (applied to
 *                                 the flowlines that have format JS, or to the
 *                                 selected one if none do)
 *
 * @returns {Promise<{ok: boolean, customjs: ?string, formats: ?Object, error: ?string}>}
 */
async function fetchStudioCode(creativeId) {
  let customjs = null;
  let formats = null;
  try {
    const response = await fetch(previewUrlFor(creativeId), { cache: 'no-store' });
    if (!response.ok) {
      return { ok: false, customjs: null, formats: null, error: `HTTP ${response.status}: ${response.statusText}` };
    }
    const parsed = parsePreview(await response.text(), creativeId);
    customjs = parsed.customjs;
    formats = parsed.flowlines ? parsed.formats : null;
  } catch (err) {
    if (!process.env.RAD_CODER_FAKE_REMOTE_JS && !process.env.RAD_CODER_FAKE_REMOTE_FORMAT) {
      return { ok: false, customjs: null, formats: null, error: err.message };
    }
  }
  return applyFakes({ ok: true, customjs, formats, error: null });
}

function applyFakes(result) {
  const fakeJs = process.env.RAD_CODER_FAKE_REMOTE_JS;
  if (fakeJs) {
    try {
      result.customjs = fs.readFileSync(fakeJs, 'utf-8');
    } catch (err) {
      return { ok: false, customjs: null, formats: null, error: `fake remote unreadable: ${err.message}` };
    }
  }
  const fakeFormat = process.env.RAD_CODER_FAKE_REMOTE_FORMAT;
  if (fakeFormat) {
    let code;
    try {
      code = fs.readFileSync(fakeFormat, 'utf-8');
    } catch (err) {
      return { ok: false, customjs: null, formats: null, error: `fake format unreadable: ${err.message}` };
    }
    const formats = { ...(result.formats || {}) };
    const withCode = Object.keys(formats).filter((id) => formats[id]);
    const targets = withCode.length ? withCode : (process.env.RAD_CODER_FAKE_FORMAT_FLOWLINES || '').split(',').filter(Boolean);
    for (const id of targets) formats[id] = code.trim() ? code : null;
    result.formats = formats;
  }
  return result;
}

module.exports = {
  previewUrlFor,
  extractJsonValue,
  extractCustomJs,
  extractFlowlines,
  formatsFromFlowlines,
  parsePreview,
  fetchStudioCode,
  applyFakes,
};

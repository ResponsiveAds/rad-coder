/**
 * The format's stylesheet, with the local format.css in place of Studio's
 *
 * Every flowline ("format") has a published stylesheet, rad-fl-<flowlineId>.css.
 * Radical loads it into the page that holds the ad (not in a SafeFrame). Studio
 * builds it from two parts:
 *   1. generated rules for the format's sizes — all scoped to .rad-fl-<flowlineId>
 *   2. the format's Custom CSS (Format → Custom CSS), appended as written, minified
 *
 * To test a local format.css, the dev server serves that stylesheet itself: part 1
 * from the published file, part 2 from format.css. The published file is minified
 * as a whole, so part 2 can only be recognised by what it contains: it starts at
 * the first rule that is not scoped to .rad-fl-<flowlineId>, and only when that
 * rule really is in Studio's Custom CSS. Custom rules that are themselves scoped
 * to .rad-fl-<flowlineId> and come before it stay in; the local format.css follows
 * them, so its declarations still win.
 */

/** Split CSS into its top-level statements (rules, at-rules), comments kept with the next one */
function splitStatements(css) {
  const out = [];
  let depth = 0;
  let start = 0;
  let quote = null;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) { out.push(css.slice(start, i + 1)); start = i + 1; }
    } else if (c === ';' && depth === 0) {
      out.push(css.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (css.slice(start).trim()) out.push(css.slice(start));
  return out;
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** { prelude, body } of one statement; body is null for statements without a block */
function parts(statement) {
  const text = stripComments(statement).trim();
  const open = text.indexOf('{');
  if (open === -1) return { prelude: text, body: null };
  return { prelude: text.slice(0, open).trim(), body: text.slice(open + 1, text.lastIndexOf('}')) };
}

/** Is this statement one of the rules Studio generates for the format? */
function isGenerated(statement, scope) {
  const { prelude, body } = parts(statement);
  if (!prelude) return true; // a stray comment
  if (body === null) return false;
  if (/^@(media|supports)\b/i.test(prelude)) {
    return splitStatements(body).every((inner) => isGenerated(inner, scope));
  }
  if (prelude[0] === '@') return false;
  return prelude.split(',').every((selector) => selector.trim().startsWith(scope));
}

/** Selectors of the first plain rule in a statement (looking into @media) */
function firstSelectors(statement) {
  const { prelude, body } = parts(statement);
  if (body !== null && /^@(media|supports)\b/i.test(prelude)) {
    const inner = splitStatements(body);
    return inner.length ? firstSelectors(inner[0]) : [];
  }
  return prelude.split(',').map((s) => s.trim()).filter(Boolean);
}

/** For comparing a minified selector with hand-written CSS */
function squash(text) {
  return stripComments(String(text)).replace(/[\s"']/g, '');
}

/**
 * The generated part of a published flowline stylesheet.
 * @param {string} published  contents of rad-fl-<flowlineId>.css
 * @param {string} flowlineId
 * @param {?string} studioCss the format's Custom CSS as it is in Studio
 */
function generatedPart(published, flowlineId, studioCss) {
  if (!studioCss || !studioCss.trim()) return published;
  const scope = `.rad-fl-${flowlineId}`;
  const statements = splitStatements(published);
  const at = statements.findIndex((statement) => !isGenerated(statement, scope));
  if (at === -1) return published;
  // Cut only when the rule is known to be custom; never drop generated rules on a guess
  const custom = squash(studioCss);
  const known = firstSelectors(statements[at]).some((selector) => custom.includes(squash(selector)));
  return known ? statements.slice(0, at).join('') : published;
}

/**
 * The stylesheet a flowline renders with on the test pages.
 * @param {Object} arg
 * @param {?string} arg.published  the published stylesheet (null: could not be fetched)
 * @param {string} arg.flowlineId
 * @param {?string} arg.studioCss  the format's Custom CSS in Studio
 * @param {?string} arg.localCss   format.css, when this flowline uses it (else null)
 * @param {boolean} [arg.plain]    generated rules only (?noformat=1)
 */
function compose({ published, flowlineId, studioCss, localCss, plain = false }) {
  if (localCss === null && !plain) return published || '';
  const base = published === null
    ? `/* rad-coder: could not fetch the published stylesheet of flowline ${flowlineId} */`
    : generatedPart(published, flowlineId, studioCss);
  if (plain) return `${base}\n/* rad-coder: format CSS left out (?noformat=1) */\n`;
  return `${base}\n/* ---- format.css (local, served by rad-coder) ---- */\n${localCss}\n`;
}

module.exports = { splitStatements, generatedPart, compose };

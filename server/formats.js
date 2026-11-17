/**
 * Which flowlines the local format.js belongs to
 *
 * A creative has one or more flowlines (called "formats" in the Studio UI). Each
 * can carry its own format JS (Format → Custom JS). Often several flowlines of a
 * creative carry the same code (copies of one format, e.g. a 400-tall and a
 * 250-tall version of a sticky leaderboard); often only one has any.
 *
 * rad-coder keeps ONE local format.js. It belongs to one flowline — the "owner",
 * recorded in .rad-coder.json as format.flowlineId — and to every other flowline
 * whose Studio format JS is identical to the owner's. Those flowlines render with
 * the local format.js; all other flowlines render with their own Studio format JS,
 * exactly as they would live.
 *
 * The format CSS (Format → Custom CSS) works the same way, in format.css. It has
 * the same owner flowline as format.js, and also applies to every flowline whose
 * Studio format CSS is identical to the owner's.
 */

const sync = require('./sync');

/**
 * Pick the owner flowline on a first run.
 *   1. the selected flowline, if it has format JS in Studio
 *   2. otherwise the first flowline that has format JS
 *   3. the same two steps for format CSS
 *   4. otherwise null — there is no format code to work on yet
 */
function pickOwner(flowlineIds, formats, selectedId, formatCss = {}) {
  for (const codes of [formats, formatCss]) {
    if (selectedId && codes[selectedId]) return selectedId;
    const first = flowlineIds.find((id) => codes[id]);
    if (first) return first;
  }
  return null;
}

/**
 * Flowlines that use the local format.js: the owner, plus every flowline whose
 * Studio format JS equals the owner's Studio format JS. With kind 'formatCss' and
 * the Studio format CSS map, the same for format.css.
 */
function appliesTo(ownerId, flowlineIds, formats, kind = 'format') {
  if (!ownerId) return [];
  const ownerCode = formats[ownerId];
  const ids = [ownerId];
  if (!ownerCode) return ids;
  for (const id of flowlineIds) {
    if (id !== ownerId && formats[id] && sync.sameCode(formats[id], ownerCode, kind)) ids.push(id);
  }
  return ids;
}

/** Distinct format JS groups in Studio, for "this creative has N different format JS" notes */
function distinctFormats(flowlineIds, formats) {
  const groups = [];
  for (const id of flowlineIds) {
    const code = formats[id];
    if (!code) continue;
    const group = groups.find((g) => sync.sameCode(formats[g[0]], code));
    if (group) group.push(id); else groups.push([id]);
  }
  return groups;
}

module.exports = { pickOwner, appliesTo, distinctFormats };

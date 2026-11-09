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
 */

const sync = require('./sync');

/**
 * Pick the owner flowline on a first run.
 *   1. the selected flowline, if it has format JS in Studio
 *   2. otherwise the first flowline that has format JS
 *   3. otherwise null — there is no format JS to work on yet
 */
function pickOwner(flowlineIds, formats, selectedId) {
  if (selectedId && formats[selectedId]) return selectedId;
  return flowlineIds.find((id) => formats[id]) || null;
}

/**
 * Flowlines that use the local format.js: the owner, plus every flowline whose
 * Studio format JS equals the owner's Studio format JS.
 */
function appliesTo(ownerId, flowlineIds, formats) {
  if (!ownerId) return [];
  const ownerCode = formats[ownerId];
  const ids = [ownerId];
  if (!ownerCode) return ids;
  for (const id of flowlineIds) {
    if (id !== ownerId && formats[id] && sync.sameCode(formats[id], ownerCode)) ids.push(id);
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

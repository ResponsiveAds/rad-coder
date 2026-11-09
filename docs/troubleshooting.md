# Troubleshooting

Symptoms first, in the order you're likely to hit them.

## `rad.getElementById('x')` returns null/undefined

- You called it before render. Move the call inside `rad.onRender(...)`.
- The ID doesn't exist in this creative (IDs are editor-generated and creative-specific).
  Re-run element discovery: log `Object.keys(arg.elementDefs)` in `onBeforeRender` and read
  the browser console.
- The element may exist only in *some* layout sizes — a designer can omit elements from a
  layout. Check at the size you're testing (`rad.getRenderedSize()`).

## Text change doesn't show up / textbox looks empty

You set the DOM text directly. Textboxes shrink-to-fit and need a layout recalculation:
use `el.updateContent('...')`, or after manual DOM edits call `el.updateShrink()`. For
visibility/styles use `rad.updateElementStyles(el.domNode, {...})`, which handles this.

## Click/hover handler fires multiple times

You registered it in `onRender`, which refires on every resize. Move listener registration
to `onLoad` (fires once).

## Change flickers: default content shows, then swaps

You changed content post-render. For data-driven content, mutate `arg.elementDefs` in
`onBeforeRender` instead — see `curl -s http://localhost:3000/rad/docs/dynamic-content.md`.

## Works on the test page, breaks the editor

Code ran inside the Studio editor. Every behavior must sit behind:

```javascript
if (!rad.getMergedContent().inEditor) { ... }
```

Only the hook *registrations* belong inside the guard; function declarations can stay outside.

## Nothing reloads when custom.js is saved

- The dev server watches `custom.js`, `format.js` and `pages/` **in the directory it was
  started from**. Confirm you're editing the same file (`http://localhost:3000/api/custom-js`
  shows what the server sees).
- The browser tab may have lost its WebSocket; reload the test page manually once.
- Is the server actually running? `curl -s http://localhost:3000/api/config`.

## `npx rad-coder` fails to start

- "Failed to fetch creative config": the creative ID is wrong, or the preview page isn't
  reachable. Open `https://studio.responsiveads.com/creatives/<id>/preview` in a browser to
  check.
- Port 3000 already in use: another rad-coder (or other server) is running. Reuse it if it's
  serving the same creative (`/api/config`), otherwise stop it first.
- `/api/config` returns 503 right after start: it's still fetching from Studio — keep
  polling for up to ~30s.

## My code seems to run twice / state resets

The whole ad re-renders on resize and on hot reload. Keep state in variables initialized at
the top of the script, treat `onRender` as re-entrant, and never assume it runs once.

## Errors are hard to trace in the console

Keep the first line of custom.js as `//# sourceURL=RAD.js` — errors and breakpoints then
show up under `RAD.js` in DevTools instead of an anonymous eval.

## Ad tag parameters are empty locally

Expected: the test page passes no ad-tag parameters. Code defensively with fallbacks
(`options.foo || 'default'`). To test parameter-driven behavior, append the parameters to
the test page URL: `http://localhost:3000/test.html?foo=bar` and read them via
`rad.getAdTagOptions()`.

## The ad renders in an iframe — my DOM queries find nothing

Your custom.js runs inside the ad's own window, so plain `document.querySelector` works on
the ad's document. But if you're inspecting from the *test page* console (top window),
switch the DevTools frame context to the ad iframe first.

## Format JS does nothing / runs twice

- Check which format JS the flowline renders with: `curl -s "http://localhost:3000/api/format-js?flowline=<id>"`
  (`source` is `local`, `studio` or `none`). Only the flowlines in `format.appliesTo` use
  `format.js`.
- Two copies run by design (creative window + the tag's window). The first one must mark
  the creative window so the second one stands down — see "Format JS and client test pages"
  in AGENTS.md.
- In a SafeFrame (`?frame=safeframe` on a client page) only the copy in the tag's window
  runs, and the publisher page cannot be touched.

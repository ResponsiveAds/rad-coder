# rad-coder

A development environment for testing ResponsiveAds creative custom JavaScript with hot-reload.



https://github.com/user-attachments/assets/ce7515c5-0920-4f02-b430-6af69fc2d44d



## Quick Start

```bash
npx rad-coder <creativeId>
```

Or with a full preview URL:

```bash
npx rad-coder https://studio.responsiveads.com/creatives/697b80fcc6e904025f5147a0/preview
```

## What It Does

1. **Creates files** in your current directory:
   - `custom.js` - Your custom JavaScript code
   - `AGENTS.md` - Instructions for AI coding assistants (Copilot, Codex, Cursor, Claude…)
   - `CLAUDE.md` - One line (`@AGENTS.md`) so Claude Code loads the same instructions

2. **Fetches creative config** from ResponsiveAds Studio automatically

3. **Starts a dev server** at `http://localhost:3000` (or next available port)

4. **Opens your browser** with the test page showing your creative

5. **Hot-reload** - Edit `custom.js`, save, and the browser automatically reloads

6. **Watches Studio** - Warns you if someone edits the creative's custom JS in Studio while
   you work, so you never paste a stale copy over their changes ([see below](#studio-sync))

7. **Format JS** - Pulls the format's Custom JS into `format.js` when the creative has one,
   applies it on the test page like a live tag would, and guards it like `custom.js`
   ([see below](#format-js))

8. **Client test pages** - Test the creative and its format JS on a copy of the publisher's
   page, in a GPT friendly iframe or a GAM SafeFrame ([see below](#client-test-pages))

## Usage

### Basic Usage

```bash
# Start rad-coder with your creative ID (creates a ./<id> folder)
npx rad-coder 697b80fcc6e904025f5147a0
```

### Continue Working

Next time, just `cd` into the project folder and run without arguments:

```bash
cd 697b80fcc6e904025f5147a0
npx rad-coder
```

The CLI auto-detects the creative from `.rad-coder.json` (or the folder name). Your local `custom.js` is used as-is — no prompts.

### Options

```bash
npx rad-coder <id> --reset       # Overwrite local custom.js and format.js with the Studio versions
npx rad-coder <id> --fresh       # Delete folder and start from scratch (keeps pages/ and the Studio archive)
npx rad-coder <id> --editor=cursor  # Use a specific editor
npx rad-coder <id> --no-editor   # Don't auto-open editor
npx rad-coder <id> --port=3100   # Preferred starting port (falls back if busy)
npx rad-coder <id> --no-ui       # Non-interactive mode for automation/agent harnesses
npx rad-coder <id> --no-sync-check  # Skip comparing local custom.js / format.js against Studio
npx rad-coder <id> --flowline=sidebar  # Start on a flowline (id, or part of its name)
npx rad-coder <id> --page=atlantic     # Open pages/atlantic.html instead of test.html
npx rad-coder <id> --new-page=atlantic # Create pages/atlantic.html from the template and open it
```

### With AI Assistants

The generated `AGENTS.md` is the whole guide an AI assistant needs: how to talk to people who
aren't developers, how to discover the creative's elements, which Radical hook to use, how to
verify and hand off, the Studio sync rules, format JS and client test pages, and the full
Radical API. `CLAUDE.md` imports it for Claude Code. Two longer references are served on
demand: `http://localhost:3000/rad/docs/dynamic-content.md` and
`http://localhost:3000/rad/docs/troubleshooting.md`.

When a newer rad-coder ships a newer guide, an unedited `AGENTS.md` is replaced on the next
start (the old one is backed up in `.rad-coder/backups/`). A copy with your own edits is kept.

### Workflow

1. Run `npx rad-coder <creativeId>` (first time — creates project folder)
2. Edit `custom.js` in your favorite editor
3. Save the file - browser auto-reloads
4. See your changes applied to the creative instantly
5. Next session: `cd <creativeId> && npx rad-coder` to continue

## Features

- **Zero configuration** - Just provide a creative ID
- **Auto-detection** - Extracts flowline, sizes, and settings from Studio
- **Hot-reload** - Instant feedback when you save changes
- **Studio sync guard** - Detects when Studio and your local `custom.js` / `format.js` have drifted apart
- **Format JS** - Edit a format's Custom JS locally and see it on the test page
- **Client test pages** - Friendly iframe and SafeFrame emulation for publisher page mimics
- **AI-ready** - Includes documentation for AI coding assistants
- **Cross-platform** - Works on macOS, Linux, and Windows

## Studio sync

Custom JS lives in two places that can both be edited: **Studio**
(Creative → Settings → Custom JS) and your local `custom.js`. There is no write API for
Studio, so getting local code live is a manual copy-paste — which makes a stale local copy
dangerous. Pasting one over a version a colleague changed silently destroys their work.

rad-coder guards against that. It compares three things: your local `custom.js`, Studio's
current version, and the **base** — the version the two last agreed on, stored in
`.rad-coder/base.js`. Comparing all three tells "I have unpushed edits" apart from
"someone changed Studio":

| State | Meaning | What rad-coder does |
|-------|---------|---------------------|
| `in-sync` | local matches Studio | nothing, just confirms it |
| `local-ahead` | your unpushed edits | one-line note; reminds you Studio needs the paste |
| `remote-ahead` | Studio changed, you didn't | pulls it (after backing your copy up) |
| `diverged` | **both sides changed** | writes `custom.remote.js`, warns loudly, changes nothing |
| `unknown-divergence` | sides differ, no base yet | treated like `diverged` |

The check runs at startup **and** every 60 seconds while the dev server is up, so a session
left open for hours still notices. When Studio changes under you it is archived immediately.

### Resolving a conflict

1. `custom.remote.js` appears next to `custom.js` — that is Studio's current version.
2. Use **Diff vs Studio** in the menu (or diff the two files) to see what Studio has that you
   don't. Analytics and event-tracking code is the usual casualty.
3. Merge what you need into `custom.js`, then paste the merged file into Studio.

rad-coder stops warning once the two sides match again — it notices the paste-back on its
next Studio check and records the new base automatically.

### The `.rad-coder/` folder

```
<creativeId>/
├── custom.js              your working file
├── custom.remote.js       Studio's version — only present during a conflict
├── format.js              the format's Custom JS — only when the creative has one
├── format.remote.js       Studio's format JS — only present during a conflict
├── pages/                 client test pages (yours; kept by --fresh)
└── .rad-coder/
    ├── base.js            the custom JS local and Studio last agreed on
    ├── history/<ts>.js    every distinct custom JS ever seen in Studio (last 50)
    ├── format/            the same base + history for format.js
    └── backups/<ts>.js    custom-*.js / format-*.js before rad-coder overwrote them (last 20 each)
```

`history/` is the safety net: if a Studio version is ever lost, it is recoverable here.
It survives `--fresh` (which deletes everything else in the folder), because it records what
Studio contained rather than local scratch work. Don't edit or delete anything in
`.rad-coder/` — it is the only local record of what Studio used to contain.

### Menu actions

While the dev server runs, the interactive menu offers **Check Studio Now**,
**Diff vs Studio**, and **Pull from Studio** (which backs up your file first).
**Server Status** shows the current sync state and when Studio was last checked.

## Format JS

A creative's flowlines ("formats" in Studio) can carry their own Custom JS
(Format → Custom JS). It decides how the ad behaves on the publisher's page: sticky
leaderboards, sidebars that fit the window, resizing the ad server's iframe.

When any flowline of the creative has format JS, rad-coder pulls it into **`format.js`**:

- `format.js` belongs to one flowline (recorded as `format.flowlineId` in `.rad-coder.json`):
  the selected flowline if it has format JS, otherwise the first flowline that has some. It
  also belongs to every other flowline whose Studio format JS is identical (copies of the same
  format, e.g. a 400-tall and a 250-tall version).
- Those flowlines render with your local `format.js`. Every other flowline renders with its own
  Studio format JS, exactly as it would live.
- No format JS in Studio? No `format.js` is created. To start one, create the file (there is a
  starter at `http://localhost:3000/rad/templates/format.js`); it belongs to the flowline you
  are testing.
- The test page applies it the way a live tag does: as `flowlineCustomjs` inside the creative,
  **and** as a second copy in the page once Radical has loaded (live, the format JS is appended
  to the deployment script `d-<id>.js`). Open `test.html?noformat=1` to compare without it.
  This is injected by the server, so projects with an older `test.html` get it too.
- **Switch formats on the test page:** the toolbar has a **Format** menu when the creative has
  more than one flowline, or open `test.html?flowline=<id or part of the name>`. Each format
  renders with its own format JS (local `format.js` or Studio's), and hot reload keeps the
  chosen format. `--flowline=` still picks the default one at start.
- Same Studio sync guard as `custom.js`: base in `.rad-coder/format/base.js`, Studio history in
  `.rad-coder/format/history/`, `format.remote.js` on a conflict, warnings in the terminal and
  the browser, and menu items **Diff format.js vs Studio** / **Pull format.js from Studio**.
- To go live, paste `format.js` into Format → Custom JS of that flowline in Studio (and of each
  identical copy). If the format is shared with other creatives, rad-coder warns you: pasting
  changes every creative that uses it.

## Client test pages

Some formats only make sense on the publisher's page: a sticky leaderboard under a sticky
nav, a sidebar in a fixed slot. For those, build a copy of the publisher page in
**`pages/<name>.html`** in the project folder. rad-coder serves it at
`http://localhost:3000/pages/<name>.html`, with hot reload on every save of `custom.js`,
`format.js` or anything in `pages/`.

```bash
npx rad-coder <id> --new-page=atlantic   # start from the template (it lists what to measure)
npx rad-coder <id> --page=atlantic       # open it instead of test.html
```

The page holds the publisher's layout and the slot's markup. The ad goes in with one script
tag per slot; the harness does the rest (config, custom.js, format JS, the ad server's iframe,
a debug panel):

```html
<script src="/rad/harness.js"
        data-slot="#leaderboard-article"
        data-frame="friendly"
        data-size="4x4"
        data-flowline="400H"
        data-debug-events="rad-sticky-leaderboard"></script>
```

| Attribute | Meaning |
|-----------|---------|
| `data-slot` | element the ad goes into (required) |
| `data-frame` | `friendly` — GPT friendly iframe (default); `safeframe` — cross-origin GAM SafeFrame with a `$sf.ext` shim; `none` — tag straight in the page |
| `data-size` | size of the ad server's iframe, e.g. `4x4`, `600x1200` |
| `data-flowline` | flowline id or part of its name (default: the selected flowline, or format.js's flowline) |
| `data-options` | JSON merged into the Radical options, e.g. `{"singleSize":{"width":600,"height":1200}}` |
| `data-frame-id`, `data-sandbox` | copy the publisher's iframe id / `sandbox="gpt"` |
| `data-debug-events` | CustomEvent names (fired by your format JS) to show in the debug panel |

- Query parameters override the attributes: `?flowline=`, `?frame=`, `?noformat=1`, `?debug=0`.
- **SafeFrame emulation**: the dev server listens on both `127.0.0.1` and `::1`, and the
  harness loads the ad frame from the other name (`localhost` ↔ `127.0.0.1`), so the frame
  really is cross-origin. Radical then behaves as in a GAM SafeFrame (no flowline CSS, no
  `flowlineCustomjs`; only the deployment-script copy of the format JS runs).
- The page receives `rad:slot-render-ended` (like GPT's slotRenderEnded) to mimic what the
  publisher's script does when an ad renders.
- `window.__radHarness` exposes slots, errors and events for browser tools and AI agents;
  `await __radHarness.evalInFrame('return …')` runs code inside the ad frame, even cross-origin.
- `--fresh` keeps `pages/`.

## Requirements

- Node.js 18.0.0 or higher

## How It Works

rad-coder fetches your creative's configuration from the ResponsiveAds Studio preview page, extracts the flowline settings, and creates a local development environment. Your custom JavaScript is injected into the creative via the `customjs` config property.

The server watches your `custom.js` file for changes and uses WebSocket to signal the browser to reload when you save.

## API Reference

The dev server exposes:

| Endpoint | Returns |
|----------|---------|
| `GET /api/config` | creative config fetched from Studio (flowline, sizes, `customjs`, `format`) |
| `GET /api/custom-js` | the current contents of your local `custom.js` |
| `GET /api/sync-status` | local-vs-Studio sync `state`, hashes, and last check time for custom.js; the same for format.js under `format` |
| `GET /api/format-js?flowline=<id>` | the format JS that flowline renders with: `code`, `source` (`local` / `studio` / `none`), and which flowlines `format.js` belongs to |
| `GET /api/pages` | the client test pages in `pages/` |
| `GET /pages/<name>.html` | a client test page (with hot reload injected) |
| `GET /rad/templates/page.html`, `/rad/templates/format.js` | starter files to copy into the project |

See the generated `AGENTS.md` file for complete Radical API documentation, including:

- Lifecycle hooks
- Element manipulation
- Carousel and TextBox components
- Dynamic Content Optimization (DCO)
- Analytics tracking

## Development

Instructions for developers who want to modify rad-coder itself.

### Setup

```bash
# Clone the repository
git clone https://github.com/ResponsiveAds/rad-coder.git
cd rad-coder

# Install dependencies
npm install

# Link the package globally for local testing
npm link
```

### Testing Your Changes

After making changes, test locally:

```bash
# Create a test directory
mkdir /tmp/test-rad-coder
cd /tmp/test-rad-coder

# Run rad-coder (uses your linked local version)
rad-coder 697b80fcc6e904025f5147a0

# Or run directly without linking
node /path/to/rad-coder/bin/cli.js 697b80fcc6e904025f5147a0
```

### Debug Mode

Run the tool with Node.js debugger for step-through debugging:

```bash
# From the rad-coder repository directory:

# Start with debugger (attach Chrome DevTools or VS Code)
npm run debug -- 697b80fcc6e904025f5147a0

# Start with debugger and break on first line
npm run debug-brk -- 697b80fcc6e904025f5147a0

# Or run directly with node inspect flags
node --inspect bin/cli.js 697b80fcc6e904025f5147a0
node --inspect-brk bin/cli.js 697b80fcc6e904025f5147a0
```

**Connecting to the debugger:**

1. **Chrome DevTools**: Open `chrome://inspect` in Chrome, click "inspect" under Remote Target
2. **VS Code**: Use the "Attach to Node Process" debug configuration, or add this to `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug rad-coder",
      "program": "${workspaceFolder}/bin/cli.js",
      "args": ["697b80fcc6e904025f5147a0"],
      "cwd": "/tmp/test-rad-coder"
    }
  ]
}
```

**Available npm scripts:**

| Script | Description |
|--------|-------------|
| `npm run dev -- <creativeId>` | Run via CLI (copies templates to cwd) |
| `npm run server -- <creativeId>` | Run server directly (uses repo's templates dir for custom.js) |
| `npm run debug -- <creativeId>` | Run CLI with debugger attached |
| `npm run debug-brk -- <creativeId>` | Run CLI with debugger, break on first line |
| `npm run debug:server -- <creativeId>` | Run server directly with debugger attached |

**Difference between `dev` and `server`:**

- `npm run dev` - Runs `bin/cli.js` which copies template files to user's directory, then starts the server. Use this to test the full npx experience.
- `npm run server` - Runs `server/index.js` directly, using the `templates/` directory for `custom.js`. Use this when developing the server itself without needing to copy files.

### Project Structure

```
rad-coder/
├── bin/
│   └── cli.js          # CLI entry point - handles file copying and starts server
├── server/
│   ├── index.js        # Express server - fetches config, serves files, hot-reload
│   ├── studio.js       # Reads the creative (custom JS, flowlines, format JS) from the preview page
│   ├── sync.js         # Studio <-> local custom.js / format.js comparison, history, backups
│   ├── formats.js      # Which flowlines format.js belongs to
│   └── tui.js          # Interactive terminal menu
├── public/
│   ├── test.html       # Test page - loads creative with custom JS
│   ├── rad-sync-banner.js  # Sync warning bar, injected into the test page
│   └── rad/
│       ├── harness.js  # Puts the creative into a slot of a client test page
│       ├── frame.html  # SafeFrame stand-in (cross-origin frame with a $sf.ext shim)
│       └── live.js     # Hot reload for client test pages
├── templates/
│   ├── custom.js       # Template copied to user's directory
│   ├── format.js       # Starter format JS (served at /rad/templates/format.js)
│   ├── page.html       # Starter client test page (--new-page)
│   └── AGENTS.md       # AI agent instructions copied to user's directory
└── package.json
```

### Key Files

| File | Purpose |
|------|---------|
| `bin/cli.js` | Entry point when user runs `npx rad-coder`. Copies template files to user's directory and starts the server. |
| `server/index.js` | Express server that fetches creative config from Studio, serves the test page, and handles hot-reload via WebSocket. |
| `server/sync.js` | Compares local `custom.js` against Studio's version, keeps the base/history/backups in `.rad-coder/`, renders diffs. |
| `public/test.html` | The test page that loads the creative and injects custom JS via the Radical config. |
| `public/rad-sync-banner.js` | Warning bar shown on the test page when local and Studio have drifted. Injected server-side by `sendTestHtml()` so it also reaches projects with an older local `test.html`. |
| `templates/custom.js` | Template for the user's custom JS file. |
| `templates/AGENTS.md` | Documentation for AI coding assistants. |

### Modifying Creative Rendering

The creative is rendered in `public/test.html`. Key areas:

1. **Fetching config**: The page fetches `/api/config` which returns creative settings from Studio.

2. **Loading custom JS**: The page fetches `/api/custom-js` which returns the user's `custom.js` content.

3. **Radical config**: The creative is initialized with:
   ```javascript
   Radical.push([creativeId, {
     flowline: config.flowlineId,
     sizes: config.sizes,
     isFluid: config.isFluid,
     // ... other settings
     config: { 
       _default: { 
         customjs: customJsCode  // User's custom JS injected here
       } 
     }
   }]);
   ```

### Modifying Config Extraction

Creative config is read from Studio's preview page by `server/studio.js` (`parsePreview()`),
which extracts:

- `window.creativeId`
- `window.creative` → `config.customjs` (the creative Custom JS)
- `window.flowlines` (array of flowline objects); each `flowline.customJS` is that format's Custom JS

`fetchCreativeConfig()` in `server/index.js` turns that into the config the test page uses.
The first flowline is selected by default (`--flowline` picks another).

### Environment Variables

When run via `npx`, the CLI sets these environment variables:

| Variable | Description |
|----------|-------------|
| `RAD_CODER_USER_DIR` | User's current working directory (where `custom.js` lives) |
| `RAD_CODER_PACKAGE_DIR` | Package installation directory (where `public/` lives) |
| `RAD_CODER_STUDIO_POLL_MS` | How often to check Studio for custom JS changes (default `60000`; `0` disables) |
| `RAD_CODER_FAKE_REMOTE_JS` | Dev/testing only: read "Studio's" custom JS from this file instead of the network, so every sync state can be reproduced locally |
| `RAD_CODER_FAKE_REMOTE_FORMAT` | Dev/testing only: read "Studio's" format JS from this file (applied to the flowlines that have format JS in Studio, or to the ids in `RAD_CODER_FAKE_FORMAT_FLOWLINES`) |
| `RAD_CODER_OPEN_PATH` | Page the browser opens (set by `--page` / `--new-page`) |

### Unlinking

When done testing, unlink the package:

```bash
npm unlink -g rad-coder
```

## License

MIT

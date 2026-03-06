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
   - `AGENTS.md` - Instructions for AI coding assistants (Copilot, Claude, etc.)

2. **Fetches creative config** from ResponsiveAds Studio automatically

3. **Starts a dev server** at `http://localhost:3000`

4. **Opens your browser** with the test page showing your creative

5. **Hot-reload** - Edit `custom.js`, save, and the browser automatically reloads

## Usage

### Basic Usage

```bash
# Create a new directory for your project
mkdir my-creative
cd my-creative

# Start rad-coder with your creative ID
npx rad-coder 697b80fcc6e904025f5147a0
```

### With AI Assistants

The generated `AGENTS.md` file contains instructions for AI coding assistants. When using VS Code with Copilot or other AI tools, they can read this file to understand:

- How to use the Radical API
- Available lifecycle hooks (`onBeforeRender`, `onLoad`, `onRender`)
- Component methods (Carousel, TextBox, etc.)
- Best practices for ResponsiveAds creatives

### Workflow

1. Run `npx rad-coder <creativeId>`
2. Edit `custom.js` in your favorite editor
3. Save the file - browser auto-reloads
4. See your changes applied to the creative instantly

## Features

- **Zero configuration** - Just provide a creative ID
- **Auto-detection** - Extracts flowline, sizes, and settings from Studio
- **Hot-reload** - Instant feedback when you save changes
- **AI-ready** - Includes documentation for AI coding assistants
- **Cross-platform** - Works on macOS, Linux, and Windows

## Requirements

- Node.js 18.0.0 or higher

## How It Works

rad-coder fetches your creative's configuration from the ResponsiveAds Studio preview page, extracts the flowline settings, and creates a local development environment. Your custom JavaScript is injected into the creative via the `customjs` config property.

The server watches your `custom.js` file for changes and uses WebSocket to signal the browser to reload when you save.

## API Reference

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
git clone https://github.com/nicatronTg/rad-coder.git
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
│   └── index.js        # Express server - fetches config, serves files, hot-reload
├── public/
│   └── test.html       # Test page - loads creative with custom JS
├── templates/
│   ├── custom.js       # Template copied to user's directory
│   └── AGENTS.md       # AI agent instructions copied to user's directory
└── package.json
```

### Key Files

| File | Purpose |
|------|---------|
| `bin/cli.js` | Entry point when user runs `npx rad-coder`. Copies template files to user's directory and starts the server. |
| `server/index.js` | Express server that fetches creative config from Studio, serves the test page, and handles hot-reload via WebSocket. |
| `public/test.html` | The test page that loads the creative and injects custom JS via the Radical config. |
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

Creative config is fetched from Studio in `server/index.js` in the `fetchCreativeConfig()` function. This parses the preview page HTML to extract:

- `window.creativeId`
- `window.flowlines` (array of flowline objects)

The first flowline is selected by default. To change this behavior, modify the logic around line 150 in `server/index.js`.

### Environment Variables

When run via `npx`, the CLI sets these environment variables:

| Variable | Description |
|----------|-------------|
| `RAD_CODER_USER_DIR` | User's current working directory (where `custom.js` lives) |
| `RAD_CODER_PACKAGE_DIR` | Package installation directory (where `public/` lives) |

### Unlinking

When done testing, unlink the package:

```bash
npm unlink -g rad-coder
```

## License

MIT

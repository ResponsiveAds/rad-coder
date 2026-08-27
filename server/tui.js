/**
 * Terminal UI Module
 * 
 * Provides an interactive arrow-key menu pinned at the bottom of the terminal
 * with a scrolling log area above it. Uses raw ANSI escape codes — zero dependencies.
 */

const readline = require('readline');

// ANSI escape helpers
const ESC = '\x1B';
const CSI = `${ESC}[`;

const ansi = {
  clearScreen: `${CSI}2J`,
  clearLine: `${CSI}2K`,
  cursorTo: (row, col) => `${CSI}${row};${col}H`,
  cursorSave: `${ESC}7`,
  cursorRestore: `${ESC}8`,
  scrollRegion: (top, bottom) => `${CSI}${top};${bottom}r`,
  resetScrollRegion: `${CSI}r`,
  showCursor: `${CSI}?25h`,
  hideCursor: `${CSI}?25l`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  cyan: `${CSI}36m`,
  green: `${CSI}32m`,
  yellow: `${CSI}33m`,
  inverse: `${CSI}7m`,
  reset: `${CSI}0m`,
};

class TUI {
  constructor() {
    this.menuItems = [];
    this.selectedIndex = 0;
    this.onSelect = null;
    this.destroyed = false;
    this.menuHeight = 0; // computed from items + header + border lines
    this._boundKeyHandler = this._handleKeypress.bind(this);
    this._boundResize = this._handleResize.bind(this);
  }

  /**
   * Initialize the TUI
   * @param {Object} options
   * @param {Array<{label: string, description?: string}>} options.menuItems
   * @param {Function} options.onSelect - callback(item, index)
   */
  init(options) {
    this.menuItems = options.menuItems || [];
    this.onSelect = options.onSelect || (() => {});
    this.selectedIndex = 0;
    this.menuHeight = this.menuItems.length + 3; // items + header + top/bottom borders

    // Set raw mode for keypress detection
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', this._boundKeyHandler);
    }

    // Handle terminal resize
    process.stdout.on('resize', this._boundResize);

    // Initial draw
    this._setupScreen();
    this._drawMenu();
  }

  /**
   * Set up ANSI scrolling region (log area = top, menu = bottom)
   */
  _setupScreen() {
    const rows = process.stdout.rows || 24;
    const logBottom = rows - this.menuHeight;

    // Set scrolling region to the top portion only
    process.stdout.write(ansi.scrollRegion(1, logBottom));

    // Position cursor in the log area
    process.stdout.write(ansi.cursorTo(logBottom, 1));
  }

  /**
   * Handle terminal resize
   */
  _handleResize() {
    if (this.destroyed) return;
    this._setupScreen();
    this._drawMenu();
  }

  /**
   * Handle raw keypress data
   */
  _handleKeypress(data) {
    if (this.destroyed) return;

    const key = data.toString();

    // Ctrl+C
    if (key === '\x03') {
      this.destroy();
      process.emit('SIGINT');
      return;
    }

    // Up arrow
    if (key === `${CSI}A`) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this._drawMenu();
      return;
    }

    // Down arrow
    if (key === `${CSI}B`) {
      this.selectedIndex = Math.min(this.menuItems.length - 1, this.selectedIndex + 1);
      this._drawMenu();
      return;
    }

    // Enter
    if (key === '\r' || key === '\n') {
      const item = this.menuItems[this.selectedIndex];
      if (item && this.onSelect) {
        this.onSelect(item, this.selectedIndex);
      }
      return;
    }

    // Number keys 1-9 for quick select
    const num = parseInt(key, 10);
    if (num >= 1 && num <= this.menuItems.length) {
      this.selectedIndex = num - 1;
      this._drawMenu();
      const item = this.menuItems[this.selectedIndex];
      if (item && this.onSelect) {
        this.onSelect(item, this.selectedIndex);
      }
      return;
    }
  }

  /**
   * Draw the menu at the bottom of the terminal
   */
  _drawMenu() {
    if (this.destroyed) return;

    const rows = process.stdout.rows || 24;
    const cols = process.stdout.cols || 80;
    const menuStartRow = rows - this.menuHeight + 1;

    // Save cursor position (in log area)
    let output = ansi.cursorSave;
    output += ansi.hideCursor;

    // Draw top border
    output += ansi.cursorTo(menuStartRow, 1);
    output += ansi.clearLine;
    output += `${ansi.dim}${'─'.repeat(Math.min(cols, 60))}${ansi.reset}`;

    // Draw header
    output += ansi.cursorTo(menuStartRow + 1, 1);
    output += ansi.clearLine;
    output += `${ansi.bold} ↑↓ Navigate  Enter Select  1-${this.menuItems.length} Quick Select${ansi.reset}`;

    // Draw menu items
    for (let i = 0; i < this.menuItems.length; i++) {
      const row = menuStartRow + 2 + i;
      const item = this.menuItems[i];
      const isSelected = i === this.selectedIndex;

      output += ansi.cursorTo(row, 1);
      output += ansi.clearLine;

      if (isSelected) {
        output += `${ansi.cyan}${ansi.bold} ❯ ${item.label}${ansi.reset}`;
        if (item.description) {
          output += `${ansi.dim}  ${item.description}${ansi.reset}`;
        }
      } else {
        output += `   ${item.label}`;
        if (item.description) {
          output += `${ansi.dim}  ${item.description}${ansi.reset}`;
        }
      }
    }

    // Restore cursor position (back to log area)
    output += ansi.cursorRestore;
    output += ansi.showCursor;

    process.stdout.write(output);
  }

  /**
   * Update menu items (e.g., for sub-menus)
   */
  updateMenu(items) {
    const oldHeight = this.menuHeight;
    this.menuItems = items;
    this.selectedIndex = 0;
    this.menuHeight = items.length + 3;

    if (this.menuHeight !== oldHeight) {
      // Clear old menu area
      const rows = process.stdout.rows || 24;
      const oldMenuStart = rows - oldHeight + 1;
      let clear = '';
      for (let i = oldMenuStart; i <= rows; i++) {
        clear += ansi.cursorTo(i, 1) + ansi.clearLine;
      }
      process.stdout.write(clear);

      // Reconfigure scroll region
      this._setupScreen();
    }

    this._drawMenu();
  }

  /**
   * Add a log message to the scrolling log area
   */
  log(message) {
    if (this.destroyed) {
      console.log(message);
      return;
    }

    const rows = process.stdout.rows || 24;
    const logBottom = rows - this.menuHeight;

    // Save cursor, move to bottom of log area, print message (scrolls within region)
    let output = ansi.cursorSave;
    output += ansi.cursorTo(logBottom, 1);
    output += '\n' + message;
    output += ansi.cursorRestore;

    process.stdout.write(output);
  }

  /**
   * Clear the log area
   */
  clearLogs() {
    const rows = process.stdout.rows || 24;
    const logBottom = rows - this.menuHeight;

    let output = '';
    for (let i = 1; i <= logBottom; i++) {
      output += ansi.cursorTo(i, 1) + ansi.clearLine;
    }
    output += ansi.cursorTo(1, 1);
    process.stdout.write(output);
  }

  /**
   * Destroy the TUI and restore terminal state
   */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    // Remove listeners
    process.stdin.removeListener('data', this._boundKeyHandler);
    process.stdout.removeListener('resize', this._boundResize);

    // Restore terminal
    process.stdout.write(ansi.resetScrollRegion);
    process.stdout.write(ansi.showCursor);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }
}

module.exports = TUI;
module.exports.ansi = ansi;

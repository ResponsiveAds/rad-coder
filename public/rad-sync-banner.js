/**
 * Studio sync banner
 *
 * Injected into the test page by the dev server (see sendTestHtml). Polls
 * /api/sync-status and shows a bar at the top of the page when the local
 * custom.js and the version in Studio have drifted apart — the browser is
 * where you are looking, so the warning has to be visible there too.
 */
(function () {
  var POLL_MS = 5000;
  var STATES = {
    'remote-ahead': {
      background: '#b45309',
      title: 'Studio has a newer custom JS than your local custom.js',
      hint: 'Someone edited this creative in Studio. Pull it from the rad-coder menu.'
    },
    'diverged': {
      background: '#b91c1c',
      title: 'CONFLICT — your local custom.js and Studio both changed',
      hint: 'Studio’s version is saved as custom.remote.js. Diff before pasting anything into Studio.'
    },
    'unknown-divergence': {
      background: '#b91c1c',
      title: 'Your local custom.js differs from Studio',
      hint: 'No sync history for this folder, so neither side can be assumed newer. Diff custom.remote.js first.'
    }
  };

  var bar = null;

  function removeBar() {
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    bar = null;
  }

  function render(status) {
    var spec = STATES[status.state];
    if (!spec) {
      removeBar();
      return;
    }

    if (!bar) {
      bar = document.createElement('div');
      bar.setAttribute('data-rad-sync-banner', '');
      bar.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
        'padding:10px 14px', 'color:#fff', 'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'box-shadow:0 1px 6px rgba(0,0,0,.35)', 'cursor:pointer'
      ].join(';');
      bar.title = 'Click to dismiss';
      bar.addEventListener('click', function () {
        removeBar();
        dismissed = true;
      });
      document.body.appendChild(bar);
    }

    bar.style.background = spec.background;
    bar.innerHTML = '';

    var title = document.createElement('strong');
    title.textContent = '⚠ ' + spec.title;
    bar.appendChild(title);

    var hint = document.createElement('div');
    hint.style.cssText = 'opacity:.9;margin-top:3px';
    hint.textContent = spec.hint + (status.summary ? ' (' + status.summary + ')' : '');
    bar.appendChild(hint);
  }

  var dismissed = false;
  var lastState = null;

  function poll() {
    fetch('/api/sync-status', { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (status) {
        // A state change re-shows a banner the user dismissed earlier.
        if (status.state !== lastState) {
          lastState = status.state;
          dismissed = false;
        }
        if (dismissed) return;
        render(status);
      })
      .catch(function () { /* server restarting — try again next tick */ });
  }

  poll();
  setInterval(poll, POLL_MS);
})();

/**
 * Studio sync banner
 *
 * Injected into the test page by the dev server (see sendTestHtml). Polls
 * /api/sync-status and shows a bar at the top of the page when the local
 * custom.js (or format.js) and the version in Studio have drifted apart — the browser is
 * where you are looking, so the warning has to be visible there too.
 */
(function () {
  var POLL_MS = 5000;
  // {file} becomes custom.js or format.js, {what} custom JS or format JS
  var STATES = {
    'remote-ahead': {
      background: '#b45309',
      title: 'Studio has a newer {what} than your local {file}',
      hint: 'Someone edited this creative in Studio. Pull it from the rad-coder menu.'
    },
    'diverged': {
      background: '#b91c1c',
      title: 'CONFLICT — your local {file} and Studio both changed',
      hint: 'Studio’s version is saved as {remote}. Diff before pasting anything into Studio.'
    },
    'unknown-divergence': {
      background: '#b91c1c',
      title: 'Your local {file} differs from Studio',
      hint: 'No sync history for this folder, so neither side can be assumed newer. Diff {remote} first.'
    }
  };
  var NAMES = {
    custom: { file: 'custom.js', what: 'custom JS', remote: 'custom.remote.js' },
    format: { file: 'format.js', what: 'format JS', remote: 'format.remote.js' }
  };

  function fill(text, kind) {
    var n = NAMES[kind];
    return text.replace('{file}', n.file).replace('{what}', n.what).replace('{remote}', n.remote);
  }

  var bar = null;

  function removeBar() {
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    bar = null;
  }

  // Problems to show: custom.js first, then format.js
  function problems(status) {
    var list = [];
    if (STATES[status.state]) list.push({ kind: 'custom', status: status });
    if (status.format && STATES[status.format.state]) list.push({ kind: 'format', status: status.format });
    return list;
  }

  function render(status) {
    var list = problems(status);
    if (!list.length) {
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

    bar.style.background = STATES[list[0].status.state].background;
    bar.innerHTML = '';

    list.forEach(function (item, i) {
      var spec = STATES[item.status.state];
      var title = document.createElement('strong');
      title.style.cssText = i ? 'display:block;margin-top:6px' : '';
      title.textContent = '⚠ ' + fill(spec.title, item.kind);
      bar.appendChild(title);

      var hint = document.createElement('div');
      hint.style.cssText = 'opacity:.9;margin-top:3px';
      hint.textContent = fill(spec.hint, item.kind) + (item.status.summary ? ' (' + item.status.summary + ')' : '');
      bar.appendChild(hint);
    });
  }

  var dismissed = false;
  var lastState = null;

  function poll() {
    fetch('/api/sync-status', { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (status) {
        // A state change re-shows a banner the user dismissed earlier.
        var state = status.state + '|' + (status.format ? status.format.state : '');
        if (state !== lastState) {
          lastState = state;
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

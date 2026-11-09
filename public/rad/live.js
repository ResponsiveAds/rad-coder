/**
 * Hot reload for client test pages (pages/*.html). Injected by the dev server.
 * Reloads the page when custom.js, format.js or anything in pages/ is saved.
 */
(function () {
  if (window.__radLive) return;
  window.__radLive = true;

  function toast(text) {
    var el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#4ecca3;color:#1a1a2e;' +
      'padding:10px 16px;border-radius:6px;font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.3)';
    (document.body || document.documentElement).appendChild(el);
  }

  function connect() {
    var ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host);
    ws.onmessage = function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (e) { return; }
      if (data.type !== 'reload') return;
      toast('Reloading' + (data.file ? ' — ' + data.file + ' changed' : '') + '…');
      setTimeout(function () { location.reload(); }, 250);
    };
    ws.onclose = function () { setTimeout(connect, 2000); };
  }

  connect();
})();

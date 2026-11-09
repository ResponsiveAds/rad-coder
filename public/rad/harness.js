/**
 * rad-coder client page harness
 *
 * Put the creative into an ad slot of a client test page (pages/*.html) the way
 * the ad server would, with the local custom.js and format.js. One script tag per
 * slot:
 *
 *   <script src="/rad/harness.js"
 *           data-slot="#leaderboard"          element the ad goes into (required)
 *           data-frame="friendly"             friendly | safeframe | none
 *           data-size="4x4"                   size of the ad server's iframe (WxH or 100%x100%)
 *           data-flowline="400"               flowline id, or part of its name
 *           data-frame-id="google_ads_iframe_/123/site/leaderboard_0"   optional
 *           data-sandbox="gpt"                optional sandbox attribute ("gpt" = GPT's list)
 *           data-options='{"singleSize":{"width":600,"height":1200}}'  merged into Radical options
 *           data-debug-events="rad-sticky-leaderboard"  CustomEvents to show in the debug panel
 *   ></script>
 *
 * Frame modes
 *   friendly   same-origin iframe the tag is written into, like a GPT friendly
 *              iframe. Radical reuses it and can reach the page (window.top).
 *   safeframe  cross-origin iframe, like a GAM SafeFrame: the frame is served from
 *              the other loopback name (localhost <-> 127.0.0.1), so the page is
 *              out of reach. A $sf.ext shim gets the frame's geometry from here.
 *   none       the tag is placed straight into the page (no ad server iframe).
 *
 * Like a live deployment script, the format JS also runs a second time in the
 * tag's window right after Radical loaded (it is appended to d-<id>.js live).
 *
 * Query parameters override the attributes: ?flowline= ?frame= ?noformat=1 ?debug=0
 * Pages listen for `rad:slot-render-ended` (detail: {slot, frame, mode}) to do what
 * the publisher's script does once an ad rendered (e.g. remove an "is-empty" class).
 * State for tools and agents: window.__radHarness
 */
(function () {
  var script = document.currentScript;
  if (!script) return;

  var params = new URLSearchParams(location.search);
  var attr = function (name) { return script.getAttribute('data-' + name); };
  var noFormat = params.get('noformat') === '1';
  var GPT_SANDBOX = 'allow-forms allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-same-origin ' +
    'allow-scripts allow-top-navigation-by-user-activation allow-presentation';
  var FL_SOURCE = 'https://s3-eu-west-1.amazonaws.com/publish.responsiveads.com/flowlines/';

  // ---------------------------------------------------------------------------
  // Shared state (one per page, however many slots)
  // ---------------------------------------------------------------------------

  var H = window.__radHarness;
  if (!H) {
    H = window.__radHarness = {
      slots: [],
      errors: [],
      events: [],
      config: null,
      /** Run code inside a slot's ad frame (works cross-origin too). Resolves with the JSON-able result. */
      evalInFrame: function (code, slotIndex) {
        var slot = H.slots[slotIndex || 0];
        if (!slot || !slot.frame) return Promise.reject(new Error('no ad frame'));
        if (slot.mode !== 'safeframe') {
          try {
            return Promise.resolve((new slot.frame.contentWindow.Function(code))());
          } catch (e) {
            return Promise.reject(e);
          }
        }
        return new Promise(function (resolve, reject) {
          var id = Math.random().toString(36).slice(2);
          slot.pendingEval[id] = { resolve: resolve, reject: reject };
          slot.frame.contentWindow.postMessage({ source: 'rad-harness', type: 'eval', id: id, code: String(code) }, '*');
          setTimeout(function () {
            if (slot.pendingEval[id]) { delete slot.pendingEval[id]; reject(new Error('timeout')); }
          }, 5000);
        });
      }
    };
    window.addEventListener('error', function (e) { addError('page', e.message || String(e)); });
    window.addEventListener('unhandledrejection', function (e) { addError('page', 'unhandled rejection: ' + (e.reason && e.reason.message || e.reason)); });
  }

  var panel = H.panel || (H.panel = createPanel());

  function addError(where, message) {
    H.errors.push({ where: where, message: String(message), at: new Date().toISOString() });
    if (H.errors.length > 50) H.errors.shift();
    panel.render();
  }

  function addEvent(name, detail, where) {
    H.events.push({ name: name, detail: detail, where: where, at: new Date().toISOString() });
    if (H.events.length > 30) H.events.shift();
    panel.render();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function getJson(url) {
    var res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
    return res.json();
  }

  function noScriptClose(s) {
    return String(s).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
  }

  function parseSize(value) {
    var m = String(value || '').match(/^\s*(\d+%?|auto)\s*x\s*(\d+%?|auto)\s*$/i);
    if (!m) return null;
    var css = function (v) { return /%$/.test(v) || v === 'auto' ? v : v + 'px'; };
    return { width: m[1], height: m[2], cssWidth: css(m[1]), cssHeight: css(m[2]) };
  }

  function pickFlowline(config, query) {
    var all = config.allFlowlines || [];
    var fmt = config.format || { appliesTo: [] };
    if (query) {
      var q = String(query).toLowerCase();
      var hit = all.find(function (f) { return f.id === query; }) ||
        all.find(function (f) { return (f.name || '').toLowerCase().indexOf(q) !== -1; });
      if (hit) return hit;
      addError('harness', 'no flowline matches "' + query + '" — using the default');
    }
    // Default: the selected flowline when it uses format.js, else format.js's own flowline
    var selected = all.find(function (f) { return f.id === config.flowlineId; });
    if (selected && (fmt.appliesTo.indexOf(selected.id) !== -1 || !fmt.flowlineId)) return selected;
    return all.find(function (f) { return f.id === fmt.flowlineId; }) || selected || all[0];
  }

  /** The other loopback origin, for a cross-origin frame */
  function otherOrigin() {
    var host = location.hostname;
    var other = host === 'localhost' ? '127.0.0.1' : host === '127.0.0.1' ? 'localhost' : null;
    return other ? location.protocol + '//' + other + (location.port ? ':' + location.port : '') : null;
  }

  function radicalOptions(config, flowline, customJs, formatJs, extra) {
    var options = {
      https: true,
      flowline: flowline.id,
      sizes: flowline.sizes,
      isFluid: flowline.isFluid,
      adSource: config.adSource,
      // the flSource Studio reports does not resolve; same override as test.html
      flSource: FL_SOURCE,
      tracking: false,
      screenshot: false,
      config: { _default: { selectedVariant: '', customjs: customJs, flowlineCustomjs: formatJs } }
    };
    Object.keys(extra || {}).forEach(function (k) {
      if (k === 'config' && extra.config && extra.config._default) {
        Object.assign(options.config._default, extra.config._default);
      } else {
        options[k] = extra[k];
      }
    });
    return options;
  }

  function tagHtml(config, options, formatJs) {
    var id = config.creativeId;
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_top"></head><body style="margin:0">' +
      '<ins id="responsivead-' + id + '"></ins>' +
      '<script>window.Radical = window.Radical || []; Radical.push(' + noScriptClose(JSON.stringify([id, options])) + ');<\/script>' +
      '<script src="' + config.radicalScript + '"><\/script>' +
      (formatJs
        ? '<script class="rad-coder-deployment-format-js">// Deployment specific custom format JS (simulated by rad-coder)\n' + noScriptClose(formatJs) + '<\/script>'
        : '') +
      '</body></html>';
  }

  // ---------------------------------------------------------------------------
  // Slot setup
  // ---------------------------------------------------------------------------

  async function run() {
    var slotSelector = attr('slot');
    var slotEl = slotSelector && document.querySelector(slotSelector);
    if (!slotEl) {
      addError('harness', 'data-slot ' + (slotSelector ? '"' + slotSelector + '" not found on the page' : 'is missing'));
      return;
    }

    var mode = (params.get('frame') || attr('frame') || 'friendly').toLowerCase();
    if (['friendly', 'safeframe', 'none'].indexOf(mode) === -1) {
      addError('harness', 'unknown frame mode "' + mode + '" — using friendly');
      mode = 'friendly';
    }
    if (mode === 'safeframe' && !otherOrigin()) {
      addError('harness', 'safeframe needs the page on localhost or 127.0.0.1 — using friendly');
      mode = 'friendly';
    }

    var extra = {};
    if (attr('options')) {
      try { extra = JSON.parse(attr('options')); } catch (e) { addError('harness', 'data-options is not valid JSON: ' + e.message); }
    }
    var debugEvents = (attr('debug-events') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);

    var config = H.config || (H.config = await getJson('/api/config'));
    var flowline = pickFlowline(config, params.get('flowline') || attr('flowline'));
    var custom = await getJson('/api/custom-js');
    var format = noFormat
      ? { code: '', source: 'disabled' }
      : await getJson('/api/format-js?flowline=' + encodeURIComponent(flowline.id));
    var options = radicalOptions(config, flowline, custom.code || '', format.code || '', extra);

    var slot = {
      slot: slotSelector,
      mode: mode,
      flowline: { id: flowline.id, name: flowline.name },
      format: { source: format.source, file: format.file || null },
      options: extra,
      frame: null,
      rendered: false,
      pendingEval: {},
      element: slotEl,
    };
    H.slots.push(slot);
    panel.render();

    debugEvents.forEach(function (name) {
      window.addEventListener(name, function (e) { addEvent(name, e.detail, 'page'); });
    });

    var size = parseSize(attr('size')) ||
      (extra.singleSize ? parseSize(extra.singleSize.width + 'x' + extra.singleSize.height) : null) ||
      (!flowline.isFluid && flowline.sizes && flowline.sizes.length === 1 ? parseSize(flowline.sizes[0]) : null) ||
      parseSize('4x4');
    var frameId = attr('frame-id') || 'google_ads_iframe_/rad-coder/' + (slotEl.id || 'slot' + H.slots.length) + '_0';

    if (mode === 'none') {
      placeInline(slot, config, options, format.code);
    } else {
      var frame = createFrame(slotEl, frameId, size);
      slot.frame = frame;
      if (mode === 'friendly') {
        fillFriendlyFrame(slot, frame, config, options, format.code, debugEvents);
      } else {
        fillSafeFrame(slot, frame, flowline, extra, debugEvents);
      }
    }
  }

  function createFrame(slotEl, frameId, size) {
    // GPT puts its iframe in a "<id>__container__" div; reuse one the page already has
    var container = slotEl.querySelector('[id$="__container__"]');
    if (!container) {
      container = document.createElement('div');
      container.id = frameId + '__container__';
      container.style.cssText = 'border: 0pt none; width: ' + size.cssWidth + '; height: ' + size.cssHeight + ';';
      slotEl.appendChild(container);
    }
    var frame = document.createElement('iframe');
    frame.id = frameId;
    frame.name = frameId;
    frame.title = '3rd party ad content';
    frame.width = size.width;
    frame.height = size.height;
    frame.scrolling = 'no';
    frame.setAttribute('marginwidth', '0');
    frame.setAttribute('marginheight', '0');
    frame.setAttribute('frameborder', '0');
    frame.setAttribute('aria-label', 'Advertisement');
    // Lets tools (e.g. RAD Assistant's analytics capture) recognise the ad server's frame
    frame.setAttribute('data-rad-harness-frame', '');
    var sandbox = attr('sandbox');
    if (sandbox) frame.setAttribute('sandbox', sandbox === 'gpt' ? GPT_SANDBOX : sandbox);
    frame.style.cssText = 'border: 0px; vertical-align: bottom;';
    container.appendChild(frame);
    return frame;
  }

  function rendered(slot) {
    slot.rendered = true;
    panel.render();
    window.dispatchEvent(new CustomEvent('rad:slot-render-ended', {
      detail: { slot: slot.element, frame: slot.frame, mode: slot.mode, flowline: slot.flowline }
    }));
  }

  function fillFriendlyFrame(slot, frame, config, options, formatJs, debugEvents) {
    var win = frame.contentWindow;
    win.addEventListener('error', function (e) { addError('ad frame', e.message || String(e)); });
    debugEvents.forEach(function (name) {
      win.addEventListener(name, function (e) { addEvent(name, e.detail, 'ad frame'); });
    });
    var doc = frame.contentDocument;
    doc.open();
    doc.write(tagHtml(config, options, formatJs));
    doc.close();
    rendered(slot);
  }

  function fillSafeFrame(slot, frame, flowline, extra, debugEvents) {
    var init = { flowline: flowline.id, options: extra, noformat: noFormat, debugEvents: debugEvents, parentOrigin: location.origin };
    frame.src = otherOrigin() + '/rad/frame.html#' + encodeURIComponent(JSON.stringify(init));

    window.addEventListener('message', function (e) {
      if (e.source !== frame.contentWindow || !e.data || e.data.source !== 'rad-harness') return;
      var d = e.data;
      if (d.type === 'error') addError('safeframe', d.message);
      else if (d.type === 'event') addEvent(d.name, d.detail, 'safeframe');
      else if (d.type === 'rendered') rendered(slot);
      else if (d.type === 'expand') expand(frame, d.delta);
      else if (d.type === 'collapse') collapse(frame);
      else if (d.type === 'eval-result') {
        var pending = slot.pendingEval[d.id];
        if (!pending) return;
        delete slot.pendingEval[d.id];
        if (d.error) pending.reject(new Error(d.error)); else pending.resolve(d.result);
      }
    });

    function geometry() {
      var r = frame.getBoundingClientRect();
      var winW = document.documentElement.clientWidth;
      var winH = window.innerHeight;
      var visW = Math.max(0, Math.min(r.right, winW) - Math.max(r.left, 0));
      var visH = Math.max(0, Math.min(r.bottom, winH) - Math.max(r.top, 0));
      return {
        win: { t: 0, l: 0, r: winW, b: winH, w: winW, h: winH },
        self: {
          t: r.top, l: r.left, r: r.right, b: r.bottom, w: r.width, h: r.height,
          xiv: r.width ? visW / r.width : 0, yiv: r.height ? visH / r.height : 0,
          iv: r.width && r.height ? (visW * visH) / (r.width * r.height) : 0
        },
        exp: { t: Math.max(r.top, 0), l: Math.max(r.left, 0), r: Math.max(winW - r.right, 0), b: Math.max(winH - r.bottom, 0), xs: 0, ys: 0 }
      };
    }
    function pushGeometry() {
      if (frame.contentWindow) frame.contentWindow.postMessage({ source: 'rad-harness', type: 'geom', geom: geometry() }, '*');
    }
    var ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { ticking = false; pushGeometry(); });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    frame.addEventListener('load', function () { pushGeometry(); setTimeout(pushGeometry, 300); setTimeout(pushGeometry, 1500); });
    setInterval(pushGeometry, 1000); // like GAM, keep the frame's geometry fresh
  }

  // $sf.ext.expand/collapse: grow the frame over the page, as GAM does
  function expand(frame, delta) {
    if (!frame.__radCollapsed) frame.__radCollapsed = { width: frame.style.width, height: frame.style.height, margin: frame.style.margin };
    var d = delta || {};
    var w = frame.offsetWidth + (d.l || 0) + (d.r || 0);
    var h = frame.offsetHeight + (d.t || 0) + (d.b || 0);
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    frame.style.margin = '-' + (d.t || 0) + 'px 0 0 -' + (d.l || 0) + 'px';
    frame.style.position = 'relative';
    frame.style.zIndex = '2147483000';
  }
  function collapse(frame) {
    var c = frame.__radCollapsed;
    if (!c) return;
    frame.style.width = c.width;
    frame.style.height = c.height;
    frame.style.margin = c.margin;
    frame.style.zIndex = '';
    frame.__radCollapsed = null;
  }

  function placeInline(slot, config, options, formatJs) {
    var el = slot.element;
    var ins = document.createElement('ins');
    ins.id = 'responsivead-' + config.creativeId;
    el.appendChild(ins);
    window.Radical = window.Radical || [];
    window.Radical.push([config.creativeId, options]);
    var lib = document.querySelector('script[data-rad-coder-radical]');
    var afterLoad = function () {
      if (formatJs) {
        var s = document.createElement('script');
        s.className = 'rad-coder-deployment-format-js';
        s.textContent = '// Deployment specific custom format JS (simulated by rad-coder)\n' + formatJs;
        document.head.appendChild(s);
      }
      rendered(slot);
    };
    if (lib) {
      afterLoad();
      return;
    }
    lib = document.createElement('script');
    lib.setAttribute('data-rad-coder-radical', '');
    lib.src = config.radicalScript;
    lib.onload = afterLoad;
    lib.onerror = function () { addError('harness', 'could not load ' + config.radicalScript); };
    document.body.appendChild(lib);
  }

  // ---------------------------------------------------------------------------
  // Debug panel
  // ---------------------------------------------------------------------------

  function createPanel() {
    var hidden = params.get('debug') === '0';
    var el = null;
    var collapsed = false;
    try { collapsed = sessionStorage.getItem('rad-harness-collapsed') === '1'; } catch (e) { /* storage blocked */ }
    var queued = false;

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
    }
    function link(label, changes, active) {
      var p = new URLSearchParams(location.search);
      Object.keys(changes).forEach(function (k) { changes[k] === null ? p.delete(k) : p.set(k, changes[k]); });
      var qs = p.toString();
      return '<a href="' + esc(location.pathname + (qs ? '?' + qs : '')) + '"' + (active ? ' class="on"' : '') + '>' + esc(label) + '</a>';
    }
    function ensure() {
      if (el || hidden || !document.body) return;
      el = document.createElement('div');
      el.id = 'rad-harness-panel';
      el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483646;max-width:min(460px,calc(100vw - 24px));' +
        'background:rgba(20,20,30,.93);color:#d8f3dc;font:12px/1.5 ui-monospace,Menlo,monospace;padding:8px 10px;' +
        'border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.35);pointer-events:auto';
      var style = document.createElement('style');
      style.textContent = '#rad-harness-panel b{color:#ffd166;font-weight:600}#rad-harness-panel a{color:#8ecae6;margin-right:8px;text-decoration:none}' +
        '#rad-harness-panel a.on{color:#fff;text-decoration:underline}#rad-harness-panel .err{color:#ff8fa3;white-space:pre-wrap}' +
        '#rad-harness-panel .ev{color:#cdb4db;white-space:pre-wrap;word-break:break-all}#rad-harness-panel .hd{cursor:pointer;user-select:none}';
      document.head.appendChild(style);
      el.addEventListener('click', function (e) {
        if (!e.target.closest('.hd')) return;
        collapsed = !collapsed;
        try { sessionStorage.setItem('rad-harness-collapsed', collapsed ? '1' : '0'); } catch (err) { /* storage blocked */ }
        draw();
      });
      document.body.appendChild(el);
    }
    function draw() {
      queued = false;
      ensure();
      if (!el) return;
      var cfg = H.config;
      var html = '<div class="hd"><b>rad-coder</b> ' + (cfg ? esc(cfg.creativeId) : '') + ' ' + (collapsed ? '▸' : '▾') +
        (H.errors.length ? ' <span class="err">' + H.errors.length + ' error' + (H.errors.length > 1 ? 's' : '') + '</span>' : '') + '</div>';
      if (!collapsed) {
        html += '<div>viewport ' + document.documentElement.clientWidth + '×' + window.innerHeight + ' · scrollY ' + Math.round(window.scrollY) + '</div>';
        H.slots.forEach(function (s) {
          var r = s.element.getBoundingClientRect();
          html += '<div><b>slot</b> ' + esc(s.slot) + ' · top ' + Math.round(r.top) + ' h ' + Math.round(r.height) + ' · ' + esc(s.mode) + (s.rendered ? '' : ' · loading…') + '</div>' +
            '<div><b>flowline</b> ' + esc(s.flowline.name) + '</div>' +
            '<div><b>format JS</b> ' + (s.format.source === 'local' ? 'format.js (local)' : s.format.source === 'studio' ? 'from Studio' : s.format.source === 'disabled' ? 'OFF (?noformat=1)' : 'none') + '</div>';
        });
        H.events.slice(-3).forEach(function (ev) {
          html += '<div class="ev">' + esc(ev.name) + ' ' + esc(JSON.stringify(ev.detail)).slice(0, 400) + '</div>';
        });
        H.errors.slice(-4).forEach(function (er) {
          html += '<div class="err">' + esc(er.where) + ': ' + esc(er.message) + '</div>';
        });
        if (cfg && cfg.allFlowlines && cfg.allFlowlines.length > 1) {
          var current = H.slots[0] && H.slots[0].flowline.id;
          html += '<div>' + cfg.allFlowlines.map(function (f) {
            var tag = cfg.format && cfg.format.appliesTo.indexOf(f.id) !== -1 ? '*' : '';
            return link((f.name || f.id).slice(0, 28) + tag, { flowline: f.id }, f.id === current);
          }).join('') + '</div>';
        }
        var mode = H.slots[0] && H.slots[0].mode;
        html += '<div>' + ['friendly', 'safeframe', 'none'].map(function (m) { return link(m, { frame: m }, m === mode); }).join('') +
          link(noFormat ? 'with format JS' : 'without format JS', { noformat: noFormat ? null : '1' }) +
          '<a href="/test.html">test.html</a></div>';
      }
      el.innerHTML = html;
    }
    var api = {
      render: function () {
        if (queued) return;
        queued = true;
        requestAnimationFrame(draw);
      }
    };
    window.addEventListener('scroll', api.render, { passive: true });
    window.addEventListener('resize', api.render);
    setInterval(api.render, 1000);
    return api;
  }

  // ---------------------------------------------------------------------------

  function start() {
    run().catch(function (err) {
      console.error('[rad-coder harness]', err);
      addError('harness', err.message || String(err));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

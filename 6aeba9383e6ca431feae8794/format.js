//# sourceURL=RAD-atlantic-drawer-format.js
/* ------------------------------------------------------------------
 * Sidekick Drawer / Adhesion Pushdown — Format JS (Studio: Format → Custom JS)
 * Flowline:   "Closed Drawer - Desktop" 6aebab5e3e6ca431feae87cf (the one the tag uses)
 * Placement:  theatlantic.com "Look Closer" articles, in-content slot (#incontent1,
 *             trafficked as 1x3), served in a GPT friendly iframe.
 *             Test key: ?adkv_test=drawer
 *
 * What the reader sees
 *  - Wide screens: the ad leaves the in-content slot and becomes a drawer stuck to
 *    the right edge of the screen, top to bottom. It loads closed (100px wide) and
 *    opens to the left (300px wide) when its open button is clicked; Close shrinks
 *    it back.
 *  - Narrow screens: the same ad is an adhesion stuck to the bottom of the screen
 *    (90 / 60 / 50px high depending on the width) and opens upwards to twice that.
 *  - The ad never covers the page: the drawer narrows the page by its own width,
 *    the adhesion adds the same amount of space under the page. The drawer is used
 *    only while the page still has MIN_PAGE_WIDTH left beside the OPEN drawer.
 *  - The in-content slot the ad was served into is collapsed (no grey band).
 *
 * How
 *  - The creative carries every layout (100x2160, 300x2160, 1200x90 … 320x100). The
 *    format picks one with ad.setSizeFilter() and sizes Radical's iframe container;
 *    the iframe is never moved in the DOM (moving it would reload the creative).
 *  - All styling lives in the Format CSS (Studio: Format → Custom CSS; local copy
 *    pages/format.css). This script only toggles classes: the state on <html>,
 *    a marker on Radical's iframe container and on the publisher's slot elements.
 *    dispose() removes them again (slot refresh, navigation). The one exception is
 *    the publisher's "sign in" bar, which sits in a shadow root (see PAGE_TOAST).
 *  - The creative's open / close buttons use Radical's built-in "sidekick" and
 *    "expandv" actions. Those open the wrong layout (the widest one) and position
 *    the frame inside the slot, so their clicks are taken over here: any element
 *    with one of these actions toggles the format's open state instead.
 *  - Open / close does not resize the frame at the click. Radical first loads the new
 *    layout's images; the frame is resized in Radical's onBeforeRender, in the same
 *    step in which the new layout is drawn, so the old layout is never shown stretched.
 *  - Creative content (elements, texts, images) is never touched.
 *
 * Where it runs
 *  - Friendly iframe / tag in page only. In a GAM SafeFrame the page cannot be
 *    reached, so the format does nothing there.
 *  - Skipped in the Studio editor and in screenshot renders.
 *  - Radical delivers format JS twice (appended to the deployment script and
 *    injected as flowlineCustomjs). The first copy to reach the creative marks its
 *    window, so the work happens once. One drawer per page.
 * ------------------------------------------------------------------ */
(function () {
    // --- layouts (must exist in the creative; see the four formats in Studio) ---
    var DRAWER = { closed: '100x2160', open: '300x2160' };
    // Adhesion layout by viewport width: the first entry whose width fits is used.
    var ADHESION = [
        { closed: '1200x90', open: '1200x180' },
        { closed: '1024x90', open: '1024x180' },
        { closed: '990x90', open: '990x180' },
        { closed: '768x90', open: '768x180' },
        { closed: '600x90', open: '600x180' },
        { closed: '480x60', open: '480x120' },
        { closed: '320x50', open: '320x100' }
    ];
    // Drawer only while the page keeps this much width beside the OPEN drawer;
    // narrower viewports get the adhesion. Measured on theatlantic.com.
    var MIN_PAGE_WIDTH = 1024;
    // Below this page width (viewport minus drawer) the Format CSS gives the site nav
    // its narrow-screen side padding back (class --tight).
    var TIGHT_PAGE_WIDTH = 1296;
    var TOGGLE_ACTIONS = ['sidekick', 'expandv'];   // built-in actions the format takes over
    var WRAPPER_SELECTORS = ['gpt-ad', '.ad__slot--wrapper'];
    // The Atlantic's "To read this story, sign in …" bar: position:fixed at the bottom
    // centre of the viewport, inside a shadow root (so the Format CSS cannot reach it).
    // It is lifted above the adhesion and re-centred on the narrowed page beside the drawer:
    // the only inline styles this format sets.
    var PAGE_TOAST = '#gate-toast';
    var TOAST_SEARCHES = 30;           // looks for the bar this many times (once per WATCH_INTERVAL)
    var RESIZE_DEBOUNCE = 120;
    var WATCH_INTERVAL = 1000;         // notices a slot that was removed without a pagehide
    var COMMIT_TIMEOUT = 2000;         // a state change goes on the page after this, even if Radical never drew it
    // Class names: keep in sync with the Format CSS
    var CLS = 'rad-atl-drawer';               // on the ad's iframe container; '--<state>' variants on <html>
    var SLOT_CLS = CLS + '-slot';             // on the publisher's slot elements around the ad
    var VAR_RIGHT = '--' + CLS + '-right';    // set by the Format CSS: px the drawer takes on the right
    var VAR_BOTTOM = '--' + CLS + '-bottom';  // set by the Format CSS: px the adhesion takes at the bottom
    var MARK = '__radAtlanticDrawer';
    var EVENT = 'rad-atlantic-drawer'; // CustomEvent for client test pages (data-debug-events)
    var DEBUG = false;                 // true: console diagnostics "[atl-drawer] …"

    function log() {
        if (!DEBUG) return;
        try {
            var parts = [].slice.call(arguments).map(function (a) {
                return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a);
            });
            console.log('[atl-drawer] ' + parts.join(' '));
        } catch (e) { /* ignore */ }
    }

    var lib = typeof Radical !== 'undefined' ? Radical : null;
    if (!lib || typeof lib.getAdByWindow !== 'function') {
        log('no Radical API in this window');
        return;
    }

    // --- entry: find the creative this copy belongs to -----------------
    // main() runs at the very end of this file: when the creative already exists
    // attach() happens synchronously, so every prototype method must be defined by then.

    function main() {
        var currentAd = null;
        try { currentAd = lib.getAdByWindow(window); } catch (e) { /* not an ad window */ }
        if (currentAd) {
            attach(currentAd);
            return;
        }
        // The deployment script runs before the ad object exists …
        if (typeof lib.onAdCreated === 'function') {
            lib.onAdCreated(attach);
        }
        // … or Radical already rendered it into an iframe of its own in this document
        try {
            var anchors = document.querySelectorAll('ins[id^="responsivead-"]');
            for (var i = 0; i < anchors.length; i++) {
                var sibling = anchors[i].nextElementSibling;
                if (sibling && sibling.tagName === 'IFRAME' && sibling.contentWindow) {
                    var existing = lib.getAdByWindow(sibling.contentWindow);
                    if (existing) attach(existing);
                }
            }
        } catch (e) { /* ignore */ }
    }

    function attach(ad) {
        try {
            attachUnsafe(ad);
        } catch (e) {
            log('attach failed', String(e && e.stack || e));
        }
    }

    function attachUnsafe(ad) {
        var container = ad.getContainer();
        var adOptions = container.getAdOptions() || {};
        var adWindow = container.getAdWindow();
        if (!adWindow) { log('attach: no ad window'); return; }
        if (adOptions.inEditor || adOptions.screenshot) { log('attach: editor/screenshot, skipping'); return; }
        if (container.isCrossOrigin && container.isCrossOrigin()) {
            log('attach: cross-origin frame (SafeFrame), the page cannot be reached, skipping');
            return;
        }
        if (adWindow[MARK]) { log('attach: already handled by the other copy'); return; }

        var frame = null;
        try { frame = adWindow.frameElement || null; } catch (e) { frame = null; }
        if (!frame) { log('attach: creative is not in an iframe, skipping'); return; }

        // Radical's iframe container in the publisher page (GPT "_container__" div)
        var node = null;
        try { node = container.getIframeContainerNode(); } catch (e) { /* older API */ }
        if (!node) node = frame.parentNode;
        var pageWin = node.ownerDocument.defaultView;

        // One drawer per page: a second slot filled by the same line item stays a normal ad
        var other = pageWin[MARK];
        if (other && !other.disposed && isConnected(other.node)) {
            log('attach: the page already has a drawer, skipping', describe(node));
            return;
        }

        var instance = new Drawer(ad, adWindow, pageWin, node, frame);
        if (!instance.layouts.drawer && !instance.layouts.adhesion.length) {
            log('attach: the creative has none of the drawer / adhesion layouts, skipping');
            return;
        }
        adWindow[MARK] = instance;
        pageWin[MARK] = instance;
        instance.start();
    }

    // --- the controller -------------------------------------------------

    function Drawer(ad, adWindow, pageWin, node, frame) {
        this.ad = ad;
        this.adWindow = adWindow;
        this.win = pageWin;
        this.doc = pageWin.document;
        this.node = node;            // the element that gets pinned to the viewport
        this.frame = frame;
        this.slotChain = slotChain(node);   // publisher elements around the ad that are collapsed
        this.layouts = readLayouts(ad);
        this.toggleIds = readToggleIds(ad);
        this.originalSizes = safe(function () { return ad.getSizeFilter().concat(); }) || [];
        this.mode = null;            // 'drawer' | 'adhesion'
        this.open = false;
        this.wanted = null;          // key of the state that was last asked for
        this.pending = null;         // that state, until it is on the page (see commit())
        this.applied = null;         // key of the state that is currently on the page
        this.commitTimer = null;
        this.offBeforeRender = null;
        this.toast = null;           // the publisher's fixed bottom bar, once found
        this.toastSearches = 0;
        this.resizeTimer = null;
        this.watch = null;
        this.disposed = false;
    }

    Drawer.prototype.start = function () {
        var self = this;
        log('start', {
            node: describe(this.node), collapsed: this.slotChain.map(describe),
            drawer: this.layouts.drawer, adhesion: this.layouts.adhesion.length, toggles: this.toggleIds
        });

        this.node.classList.add(CLS);
        for (var i = 0; i < this.slotChain.length; i++) this.slotChain[i].classList.add(SLOT_CLS);

        // Open / close buttons of the creative: take the click before Radical's built-in action
        this.onClick = function (e) { self.handleClick(e); };
        this.adWindow.addEventListener('click', this.onClick, true);

        this.onResize = function () {
            self.win.clearTimeout(self.resizeTimer);
            self.resizeTimer = self.win.setTimeout(function () { self.update(); }, RESIZE_DEBOUNCE);
        };
        this.win.addEventListener('resize', this.onResize);
        this.win.addEventListener('orientationchange', this.onResize);

        // A state change goes on the page in the step in which Radical draws its layout
        this.offBeforeRender = safe(function () {
            return self.ad.onBeforeRender(function () { self.beforeRender(); });
        });

        // Creative unloaded (navigation, slot refresh) → put the page back
        this.onPageHide = function () { self.dispose(); };
        this.adWindow.addEventListener('pagehide', this.onPageHide);
        this.watch = this.win.setInterval(function () {
            if (!isConnected(self.node) || !isConnected(self.frame)) { self.dispose(); return; }
            self.adjustToast();
        }, WATCH_INTERVAL);
        this.adjustToast();

        this.update();
    };

    // Which unit fits the current viewport, and put that state on the page
    Drawer.prototype.update = function () {
        if (this.disposed) return;
        var viewport = this.doc.documentElement.clientWidth;   // without the scrollbar
        var drawer = this.layouts.drawer;
        var fits = drawer && viewport - drawer.open.width >= MIN_PAGE_WIDTH;
        var mode = (fits || !this.layouts.adhesion.length) && drawer ? 'drawer' : 'adhesion';

        var pair = mode === 'drawer' ? drawer : pickAdhesion(this.layouts.adhesion, viewport);
        var size = this.open ? pair.open : pair.closed;
        var key = mode + '/' + (this.open ? 'open' : 'closed') + '/' + size.width + 'x' + size.height;
        if (key === this.wanted) return;

        // The state as classes on <html>; the Format CSS turns them into sizes and positions
        var states = [mode];
        if (this.open) states.push('open');
        if (mode === 'adhesion') states.push('h' + pair.closed.height);
        if (mode === 'drawer' && viewport - size.width < TIGHT_PAGE_WIDTH) states.push('tight');

        var first = this.wanted === null;
        this.wanted = key;
        this.mode = mode;
        this.pending = {
            key: key, states: states, size: size,
            detail: { mode: mode, open: this.open, size: size.width + 'x' + size.height, viewport: viewport }
        };
        // The first state goes on the page right away: the ad has to leave the slot.
        // Later ones (open / close, drawer <-> adhesion) wait for Radical: it loads the new
        // layout's images before it draws, and a frame that is resized before that shows
        // the old layout stretched to the new size. commit() runs from onBeforeRender, in
        // the same step in which Radical draws the new layout.
        if (first) this.commit();

        // Tell Radical which layout to draw; the frame resize that follows renders it again
        try {
            this.ad.setSizeFilter([{ width: size.width, height: size.height }]);
            this.ad.forceRender();
        } catch (e) { log('render failed', String(e)); }

        // Radical never drew it (an image failed to load): do not leave the page in the old state
        var self = this;
        this.win.clearTimeout(this.commitTimer);
        if (this.pending) {
            this.commitTimer = this.win.setTimeout(function () { self.commit(); }, COMMIT_TIMEOUT);
        }
    };

    // Radical is about to draw a layout: if it is the one that was asked for, resize the frame now
    Drawer.prototype.beforeRender = function () {
        var next = this.pending;
        if (!next || this.disposed) return;
        var ad = this.ad;
        var drawing = safe(function () { return ad.getRenderedSize(); });
        if (drawing && (drawing.width !== next.size.width || drawing.height !== next.size.height)) return;
        this.commit();
    };

    // Put the pending state on the page
    Drawer.prototype.commit = function () {
        var next = this.pending;
        if (!next || this.disposed) return;
        this.pending = null;
        this.win.clearTimeout(this.commitTimer);
        setStates(this.doc.documentElement, next.states);
        this.node.classList.add(CLS);   // Radical rewrites the container's class list when it applies the flowline
        this.applied = next.key;
        log('state', next.detail);
        dispatch(this.adWindow, next.detail);
        if (this.win !== this.adWindow) dispatch(this.win, next.detail);
    };

    Drawer.prototype.handleClick = function (e) {
        if (this.disposed || !this.isToggle(e.target)) return;
        // Radical's own sidekick / expand action must not run: it opens the widest layout
        // and positions the frame inside the slot
        e.stopImmediatePropagation();
        e.preventDefault();
        this.open = !this.open;
        this.update();
        try {
            this.ad.sendAnalyticsEvent({ e: this.mode === 'drawer' ? 'interact.sidekick' : 'interact.expand', v: this.open ? 1 : 0 });
        } catch (err) { /* tracking only */ }
    };

    // Is the clicked node inside a creative element that carries an open/close action?
    Drawer.prototype.isToggle = function (target) {
        for (var i = 0; i < this.toggleIds.length; i++) {
            var el = null;
            try { el = this.ad.getElementById(this.toggleIds[i]); } catch (e) { el = null; }
            var dom = el && el.domNode;
            if (dom && (dom === target || dom.contains(target))) return true;
        }
        return false;
    };

    // Keep the publisher's fixed bottom bar clear of the ad. The bar appears some time
    // after load and lives in a shadow root; its two inline margins read the custom
    // properties the Format CSS sets on <html> (they inherit into shadow trees), so it
    // follows every state change by itself once it has been found.
    Drawer.prototype.adjustToast = function () {
        if (this.disposed) return;
        if (this.toast && isConnected(this.toast)) return;
        if (this.toastSearches >= TOAST_SEARCHES) return;
        this.toastSearches++;
        var toast = findDeep(this.doc, PAGE_TOAST);
        if (!toast) return;
        this.toast = toast;
        toast.style.setProperty('margin-bottom', 'var(' + VAR_BOTTOM + ', 0px)', 'important');
        toast.style.setProperty('margin-left', 'calc(var(' + VAR_RIGHT + ', 0px) / -2)', 'important');
        log('page toast found, kept clear of the ad');
    };

    Drawer.prototype.dispose = function () {
        if (this.disposed) return;
        this.disposed = true;
        try { this.adWindow.removeEventListener('click', this.onClick, true); } catch (e) { /* frame gone */ }
        try { this.adWindow.removeEventListener('pagehide', this.onPageHide); } catch (e) { /* frame gone */ }
        try {
            this.win.removeEventListener('resize', this.onResize);
            this.win.removeEventListener('orientationchange', this.onResize);
            this.win.clearTimeout(this.resizeTimer);
            this.win.clearTimeout(this.commitTimer);
            this.win.clearInterval(this.watch);
        } catch (e) { /* ignore */ }
        if (typeof this.offBeforeRender === 'function') safe(this.offBeforeRender);
        this.pending = null;

        setStates(this.doc.documentElement, []);
        if (this.toast) {
            this.toast.style.removeProperty('margin-bottom');
            this.toast.style.removeProperty('margin-left');
        }
        this.node.classList.remove(CLS);
        for (var i = 0; i < this.slotChain.length; i++) this.slotChain[i].classList.remove(SLOT_CLS);
        try { this.ad.setSizeFilter(this.originalSizes); } catch (e) { /* ad gone */ }

        try { delete this.adWindow[MARK]; } catch (e) { /* frame gone */ }
        if (this.win[MARK] === this) { try { delete this.win[MARK]; } catch (e) { this.win[MARK] = null; } }
        log('disposed');
    };

    // --- reading the creative ---------------------------------------------

    // { drawer: {closed, open} | null, adhesion: [{closed, open}, …] } with only the
    // layouts the creative really has
    function readLayouts(ad) {
        var have = {};
        var queries = safe(function () { return ad.getActiveConfig().mediaqueries; }) || [];
        for (var i = 0; i < queries.length; i++) {
            have[queries[i].maxWidth.value + 'x' + queries[i].maxHeight.value] = true;
        }
        function pair(def) {
            if (!have[def.closed] || !have[def.open]) { log('layout missing in the creative', def); return null; }
            return { closed: parseSize(def.closed), open: parseSize(def.open) };
        }
        var adhesion = [];
        for (var j = 0; j < ADHESION.length; j++) {
            var p = pair(ADHESION[j]);
            if (p) adhesion.push(p);
        }
        adhesion.sort(function (a, b) { return b.closed.width - a.closed.width; });
        return { drawer: pair(DRAWER), adhesion: adhesion };
    }

    // The widest adhesion layout that fits the viewport (the narrowest one if none does)
    function pickAdhesion(list, viewport) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].closed.width <= viewport) return list[i];
        }
        return list[list.length - 1];
    }

    // Ids of the creative elements whose click action is an open/close toggle
    function readToggleIds(ad) {
        var ids = [];
        var elements = safe(function () { return ad.getActiveConfig().elements; }) ||
            safe(function () { return ad.getMergedContent().config._default.elements; }) || {};
        for (var id in elements) {
            if (!elements.hasOwnProperty(id)) continue;
            var actions = elements[id] && elements[id].onClick;
            if (!actions || !actions.length) continue;
            for (var i = 0; i < actions.length; i++) {
                if (TOGGLE_ACTIONS.indexOf(actions[i].action) !== -1) { ids.push(id); break; }
            }
        }
        return ids;
    }

    // The publisher's elements between the ad container and the slot wrapper
    // (#incontent1 … <gpt-ad>): collapsed while the ad is pinned to the viewport
    function slotChain(node) {
        var wrapper = null;
        for (var i = 0; i < WRAPPER_SELECTORS.length && !wrapper; i++) {
            wrapper = closest(node.parentNode, WRAPPER_SELECTORS[i]);
        }
        var chain = [];
        if (!wrapper) return chain;
        for (var el = node.parentNode; el && el.nodeType === 1; el = el.parentNode) {
            chain.push(el);
            if (el === wrapper) break;
        }
        return chain;
    }

    // --- helpers ----------------------------------------------------------

    // Replace the format's state classes on <html>: ['drawer', 'open'] → rad-atl-drawer--drawer …
    function setStates(html, states) {
        var prefix = CLS + '--';
        var old = [].slice.call(html.classList).filter(function (c) { return c.indexOf(prefix) === 0; });
        for (var i = 0; i < old.length; i++) html.classList.remove(old[i]);
        for (var j = 0; j < states.length; j++) html.classList.add(prefix + states[j]);
    }

    function parseSize(text) {
        var parts = text.split('x');
        return { width: parseInt(parts[0], 10), height: parseInt(parts[1], 10) };
    }

    function closest(el, selector) {
        if (!el || el.nodeType !== 1) return null;
        try { return el.closest(selector); } catch (e) { return null; }
    }

    // querySelector that also looks inside open shadow roots (one level)
    function findDeep(doc, selector) {
        var hit = safe(function () { return doc.querySelector(selector); });
        if (hit) return hit;
        var all = doc.body ? doc.body.getElementsByTagName('*') : [];
        for (var i = 0; i < all.length; i++) {
            var root = all[i].shadowRoot;
            if (!root) continue;
            hit = safe(function () { return root.querySelector(selector); });
            if (hit) return hit;
        }
        return null;
    }

    function isConnected(el) {
        if (!el) return false;
        return typeof el.isConnected === 'boolean' ? el.isConnected : el.ownerDocument.documentElement.contains(el);
    }

    function describe(el) {
        if (!el) return null;
        var cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
    }

    function dispatch(win, detail) {
        try { win.dispatchEvent(new win.CustomEvent(EVENT, { detail: detail })); } catch (e) { /* ignore */ }
    }

    function safe(fn) {
        try { return fn(); } catch (e) { return null; }
    }

    main();
})();

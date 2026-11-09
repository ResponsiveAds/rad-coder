//# sourceURL=RAD-format.js
/* ------------------------------------------------------------------
 * <Format name> — Format JS (Studio: Format → Custom JS)
 * Flowlines:  "<flowline name>" <flowline id>
 * Placement:  <publisher>, <slot>, served in a GPT friendly iframe | GAM SafeFrame
 *
 * What the reader sees
 *  - <describe the behaviour in plain words>
 *
 * Where it runs (Radical delivers format JS two ways)
 *  a) appended to the deployment script d-<id>.js → runs in the window that
 *     holds the ad tag (the GPT iframe, the SafeFrame document, or the page).
 *     This is the ONLY copy that runs in a SafeFrame: Radical skips the
 *     flowline step (class, template CSS, format JS) when window.top is
 *     cross-origin.
 *  b) injected by Radical into the creative window as flowlineCustomjs when it
 *     applies the flowline (friendly iframes / same-origin pages).
 *  Both copies find the creative through the Radical API; the first one to
 *  reach it marks the creative window, so the work happens once.
 *  Skipped in the Studio editor and in screenshot renders.
 *
 * Friendly iframe: the publisher page is reachable (frameElement, window.top).
 * SafeFrame:       it is not — only $sf.ext (geom(), expand()) and
 *                  IntersectionObserver tell you where the frame is.
 * ------------------------------------------------------------------ */
(function () {
    var MARK = '__radFormat';    // rename per format, e.g. __radStickyLeaderboard
    var EVENT = 'rad-format';    // CustomEvent for client test pages (data-debug-events)
    var DEBUG = true;            // console diagnostics; set false once verified live

    function log() {
        if (!DEBUG) return;
        try {
            var parts = [].slice.call(arguments).map(function (a) {
                return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a);
            });
            console.log('[format] ' + parts.join(' '));
        } catch (e) { /* ignore */ }
    }

    var lib = typeof Radical !== 'undefined' ? Radical : null;
    if (!lib || typeof lib.getAdByWindow !== 'function') {
        log('no Radical API in this window');
        return;
    }

    // --- entry: find the creative this copy belongs to -----------------

    function main() {
        var currentAd = null;
        try { currentAd = lib.getAdByWindow(window); } catch (e) { /* not an ad window */ }
        if (currentAd) {
            attach(currentAd);   // copy b): running inside the creative window
            return;
        }
        // copy a): the deployment script runs before the ad object exists …
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
        if (!adWindow) { log('no ad window'); return; }
        if (adOptions.inEditor || adOptions.screenshot) { log('editor/screenshot: skipping'); return; }
        if (adWindow[MARK]) { log('already handled by the other copy'); return; }
        adWindow[MARK] = true;

        if (container.isCrossOrigin && container.isCrossOrigin()) {
            startInSafeFrame(ad, adWindow);
            return;
        }

        var frame = null;
        try { frame = adWindow.frameElement || null; } catch (e) { frame = null; }
        if (!frame) { log('creative is not in an iframe: nothing to do'); return; }

        // Radical's iframe container in the publisher page (GPT "_container__" div)
        var node = null;
        try { node = container.getIframeContainerNode(); } catch (e) { /* older API */ }
        if (!node) node = frame.parentNode;

        startOnPage(ad, node, node.ownerDocument.defaultView);
    }

    // --- friendly iframe / same-origin: the page can be changed ----------

    function startOnPage(ad, node, pageWin) {
        log('on page', { slot: node.id || node.className, rendered: safe(function () { return ad.getRenderedSize(); }) });
        // Change only inline styles of the publisher's elements; never move the ad
        // iframe in the DOM (that reloads the creative).
        report(pageWin, { state: 'attached', mode: 'page' });
    }

    // --- SafeFrame: the page is out of reach ----------------------------

    function startInSafeFrame(ad, adWindow) {
        var sf = findSafeFrame(adWindow);
        log('in SafeFrame', { geom: sf ? sf.ext.geom() : null });
        report(window, { state: 'attached', mode: 'safeframe' });
    }

    // Walk up from the creative window looking for the SafeFrame API
    function findSafeFrame(startWindow) {
        var win = startWindow;
        for (var depth = 0; depth < 6 && win; depth++) {
            try {
                if (win.$sf && win.$sf.ext && typeof win.$sf.ext.geom === 'function') return win.$sf;
            } catch (e) { /* cross-origin level, keep walking */ }
            try {
                if (win === win.parent) break;
                win = win.parent;
            } catch (e) {
                break;
            }
        }
        return null;
    }

    // --- helpers ----------------------------------------------------------

    function report(win, detail) {
        try { win.dispatchEvent(new win.CustomEvent(EVENT, { detail: detail })); } catch (e) { /* ignore */ }
    }

    function safe(fn) {
        try { return fn(); } catch (e) { return null; }
    }

    main();
})();

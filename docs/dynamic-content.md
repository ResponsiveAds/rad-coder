# Dynamic Content (DCO), Parameters, Tracking, and the Parent Page

## Changing content before render (DCO)

`onBeforeRender(arg)` hands you `arg.elementDefs` — a plain object keyed by element ID whose
values describe exactly what will be rendered. Mutating it is the cleanest way to change
content: the ad renders directly with the new values, no flicker, no post-render reflow.

```javascript
rad.onBeforeRender(function (arg) {
    // Text
    arg.elementDefs.headlineID.textboxWidget.text = 'Custom Value';

    // Image source
    arg.elementDefs.heroImageID.image.src = 'https://example.com/image.jpg';

    // Click-through URL
    arg.elementDefs.ctaID.onClick[0].data.url = 'https://landingpage.com';
});
```

Inspect `arg.elementDefs.<id>` with `console.log` to see what an element supports — the
shape mirrors what the designer configured in the editor.

## Reading parameters from the ad tag / URL

Campaign data is usually passed as query-string parameters on the ad tag. Read them with:

```javascript
var options = rad.getAdTagOptions();
var dealerId = options.dealer_id || 'default_001';
```

Always provide a fallback — on the rad-coder test page these parameters are typically
absent, so code without defaults looks broken locally even when it's correct.

Combine with DCO:

```javascript
rad.onBeforeRender(function (arg) {
    var options = rad.getAdTagOptions();
    if (options.headline) {
        arg.elementDefs.headlineID.textboxWidget.text = options.headline;
    }
});
```

## Fetching external data

You can `fetch()`/XHR inside the ad. If the data must affect the initial render, fetch it
inside `onBeforeRender` only when the API is fast; otherwise render defaults and update
post-render (`updateContent`) so the ad never shows blank. Mind CORS: the request originates
from the ad's iframe origin.

## Analytics

Send custom interaction events for reporting:

```javascript
rad.sendAnalyticsEvent({
    e: 'interact.scroll',      // event name (dot-namespaced)
    v: 50,                     // numeric value, e.g. percent
    elId: 'scrolling_container' // related element ID
});
```

Fire `callTrackerURL(url)` for third-party pixel/tracker URLs.

## Cookies

```javascript
rad.setCookie('seen', '1', { days: 7 });
var seen = rad.getCookie('seen');
```

## Parent page access (cross-origin)

Ads usually run cross-origin to the publisher page, where parent access throws. Always check
first:

```javascript
if (!container.isCrossOrigin()) {
    var parentDoc = container.getAdWindow().top.document;
    // safe to read/interact with the parent page here
}
```

Cross-window messaging works regardless of origin — register the listener in `onLoad`:

```javascript
rad.onLoad(function () {
    window.addEventListener('message', function (e) {
        console.log('External data:', e.data);
    });
});
```

## Visibility

```javascript
container.onVisibilityChange(function (isVisible) {
    if (!isVisible) {
        // pause video/audio/animations — required by most ad networks
    }
});
```

## Detecting screenshot mode

Studio renders screenshots of creatives; skip animations/timers there:

```javascript
var inScreenshot = window.location.href.indexOf('preview?screenshot=1') > -1;
```

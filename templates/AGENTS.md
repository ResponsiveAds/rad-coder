# RAD Agents Guide

## What you are working with

A **creative** is a responsive HTML5 ad built by a designer in the ResponsiveAds editor
(Studio, studio.responsiveads.com). Designers can attach a **custom.js** snippet to a
creative to add behaviour the editor can't express. Your job is to write that snippet — and,
when the task is about how the ad behaves on a publisher's page, the **format JS**
(`format.js`, see "Format JS and client test pages" below).

- Your code is injected as a string into the ad's config and runs **inside the ad's window**
  (often an iframe). No module system: no `import`/`export`, no top-level `await`. Write one
  plain script.
- The same custom.js also runs **inside the editor** while the designer works. Everything
  must sit behind the `inEditor` guard (see the boilerplate below), or it corrupts the
  design session.
- All elements are absolutely positioned with inline styles owned by the rendering library
  ("Radical"). Work through the **Radical API**, don't invent your own DOM structure.
- **rad-coder** is already running for this folder (`npx rad-coder`). It serves the test page
  at http://localhost:3000/test.html and reloads it whenever `custom.js` or `format.js` is
  saved. Client test pages live in `pages/` (http://localhost:3000/pages/<name>.html).
- A creative can come in several **formats** (Studio "flowlines", e.g. a right and a left
  sidebar). The test page shows the default one. To see another, open
  `test.html?flowline=<id>` (or part of its name), or use the **Format** menu in the test
  page's toolbar. The ids are in `allFlowlines` of `curl -s http://localhost:3000/api/config`.

Many people you work for are **not developers** (designers, ad-ops). They say "make the
headline change after 3 seconds", never "mutate elementDefs in onBeforeRender". Do every
technical step yourself, refer to elements by what they look like ("the red Shop Now
button"), summarise changes in plain words, and never ask them to read code or use a
terminal.

## Workflow

### 1. Check the dev server

```bash
curl -s http://localhost:3000/api/config
```

JSON → it's up; note `creativeId`, `flowlineName`, `allFlowlines`, `sizes`, `isFluid` and
`format`. Connection refused → start it in the background from this folder
(`npx rad-coder --no-editor`) and poll `/api/config` until it answers (up to ~30s).

### 2. Discover the elements before writing code

Element IDs are editor-generated (`a2`, `e7`, `text1`…); never guess them. Log the element
blueprint from `onBeforeRender`, read the browser console, and map the person's words to IDs
by text/image content. Temporarily make custom.js:

```javascript
var rad = Radical.getAdByWindow(window);
if (!rad.getMergedContent().inEditor) {
    rad.onBeforeRender(function (arg) {
        Object.keys(arg.elementDefs).forEach(function (id) {
            var d = arg.elementDefs[id];
            console.log('[element]', id,
                d.textboxWidget ? 'text: ' + JSON.stringify(d.textboxWidget.text)
                : d.image ? 'image: ' + (d.image.src || '')
                : Object.keys(d).join(','));
        });
    });
}
```

Open the test page with your browser tool, read the console, and take a screenshot to see
what each element looks like. No browser tool? Ask the person to describe the ad, or to
open the test page and tell you what they see.

### 3. Write the code

Start from this boilerplate:

```javascript
//# sourceURL=RAD.js
var rad = Radical.getAdByWindow(window);
var container = rad.getContainer();

if (!rad.getMergedContent().inEditor) {
    rad.onLoad(onAdLoaded);
    rad.onBeforeRender(onBeforeRender);
    rad.onRender(onAdRender);
}

function onAdLoaded() { /* register event listeners here */ }
function onBeforeRender(arg) { /* mutate arg.elementDefs here (DCO) */ }
function onAdRender() { /* style/position tweaks, component refs here */ }
```

Pick the hook by the job — the wrong hook is the #1 source of bugs:

| You want to… | Hook | Why |
|---|---|---|
| Swap text, image src or click-through URL from data (DCO) | `onBeforeRender(arg)` → mutate `arg.elementDefs` | runs before elements exist: no flicker |
| Add click/hover/message/window listeners | `onLoad` | fires **once**; `onRender` refires on every resize → duplicate listeners |
| Change styles, get element refs, start carousels/animations | `onRender` | elements only exist after render |
| Pause media when the ad scrolls out of view | `container.onVisibilityChange(cb)` | performance and ad policy |

- `rad.getElementById('id')` only inside (or after) `onRender`; `.domNode` is the DOM element,
  component methods live on the object itself.
- Change visibility/styles with `rad.updateElementStyles(el.domNode, {...})`, text with
  `el.updateContent('…')` — textboxes need the shrink recalculation these do.
- `onRender` refires on every resize: keep it idempotent.
- Creatives render at several sizes: branch with `rad.getRenderedSize()` and check more than
  one size (resize the window, or switch flowline).

### 4. Verify — never declare done on unverified code

After every meaningful change (the page reloads by itself):

1. Console: zero errors.
2. Screenshot: the visible result matches the request.
3. Exercise it (click, wait for the timer, resize) and screenshot again.

### 5. Hand off

Remove debug `console.log`s, keep the `inEditor` guard, and tell the person in plain words
what the code does. To go live, `custom.js` is pasted into Creative → Settings → Custom JS in
Studio (and `format.js` into Format → Custom JS of its flowline). rad-coder only changes the
local test page, never the live creative. Check the Studio sync section first.

### More detail, when you need it

| Read | When |
|---|---|
| `curl -s http://localhost:3000/rad/docs/dynamic-content.md` | DCO, ad-tag/URL parameters, fetching data, analytics events, cookies, parent-page access, visibility, screenshot mode |
| `curl -s http://localhost:3000/rad/docs/troubleshooting.md` | something doesn't work: null elements, invisible text, duplicate handlers, no reload, format JS issues |
| the "Radical API" and "All Functions" sections below | every `rad.*` function, carousels, textboxes |

---

# Studio sync — read this before touching custom.js

The `custom.js` in this folder is a **local copy**. The live version lives in Studio
(Creative → Settings → Custom JS) and anyone on the team can change it there at any time.
There is no automatic push: Studio is only updated when a human pastes `custom.js` into it.

That means a stale local copy can silently destroy someone else's work. rad-coder compares
the two on every start and while the dev server runs, and tells you where you stand:

| What rad-coder prints | What it means | What you should do |
|---|---|---|
| `✓ custom.js is in sync with Studio` | identical | work normally |
| `local edits not in Studio yet` | your unpushed work | work normally; tell the user to paste when done |
| `↓ Studio has a NEWER custom JS` | someone edited Studio, you had no local changes | rad-coder pulls it for you — re-read `custom.js` before editing |
| `⚠⚠⚠ CONFLICT` / `⚠ STUDIO CHANGED` | **both sides changed** | **stop and resolve — see below** |

You can also read the state as JSON at any time:

```bash
curl -s http://localhost:3000/api/sync-status
```

`state` is one of `in-sync`, `local-ahead`, `remote-ahead`, `diverged`, `unknown-divergence`.

## On a conflict

`custom.remote.js` appears next to `custom.js` — that is Studio's current version.

1. **Do not paste `custom.js` into Studio.** You would overwrite whatever was added there.
2. Diff the two files and find what Studio has that you don't (analytics calls, event
   tracking and feed handlers are the usual casualties).
3. Merge those parts into `custom.js` by hand, keeping both sides' work.
4. Tell the user what you merged and that the merged `custom.js` is what should be pasted
   into Studio.

## Recovering an older Studio version

`.rad-coder/` keeps history so nothing is lost:

- `.rad-coder/history/<timestamp>.js` — every distinct version ever seen in Studio
- `.rad-coder/backups/custom-<timestamp>.js` — your local file before rad-coder overwrote it
- `.rad-coder/base.js` — the version the two sides last agreed on

Never edit or delete anything in `.rad-coder/` — it is the only record of what Studio used
to contain.


---

# Format JS and client test pages

## Two kinds of code

| File | Studio field | Runs | Use it for |
|---|---|---|---|
| `custom.js` | Creative → Settings → Custom JS | inside the creative's window | anything inside the ad: texts, clicks, carousels, DCO |
| `format.js` | Format → Custom JS (one per flowline/format) | inside the creative's window **and** in the window that holds the ad tag | how the ad behaves on the publisher's page: sticky, fitting a slot, resizing the ad server's iframe |

Write creative behaviour in `custom.js`. Touch `format.js` only when the task is about the
placement on a publisher page, or the user asks for it.

`format.js` exists when one of the creative's flowlines has format JS in Studio. It belongs
to one flowline (see `format` in `.rad-coder.json` or `GET /api/config` → `format`) and to
every flowline whose Studio format JS is identical. All other flowlines render with their
own Studio format JS. To start format JS for a creative that has none, run
`curl -s http://localhost:3000/rad/templates/format.js > format.js`. It then belongs to the
flowline being tested.

`format.js` has the same Studio sync guard as `custom.js`: `format.remote.js` appears on a
conflict, and `GET /api/sync-status` → `format.state` reports where it stands. It is pasted
into Studio by hand (Format → Custom JS of that flowline, and of each identical copy). If
`GET /api/config` → `format.isCreativeSpecific` is `false`, the format is shared with other
creatives: say so before the user pastes it.

## How Radical delivers format JS (both copies run)

1. As `flowlineCustomjs`, injected into the creative's window when the flowline is applied.
   Radical **skips this** when `window.top` is cross-origin (GAM SafeFrame).
2. Appended to the deployment script `d-<deployment>.js`, so it runs in the window that
   holds the ad tag: the GPT iframe, the SafeFrame document, or the page itself. In a
   SafeFrame this is the only copy.

Both copies must find the creative through the Radical API (`Radical.getAdByWindow(window)`,
`Radical.onAdCreated`, or the iframe next to `ins[id^="responsivead-"]`). The first copy
to reach the creative marks its window (`adWindow.__radSomething = true`), so the work
happens once. Skip the work when `getAdOptions().inEditor` or `.screenshot` is set. The
template (`/rad/templates/format.js`) already does all of this.

| Served in | Page reachable? | Notes |
|---|---|---|
| GPT friendly iframe (same origin) | yes: `adWindow.frameElement`, `window.top` | Radical reuses the publisher's iframe and loads the flowline CSS into the page |
| GAM SafeFrame (cross-origin) | **no** | only `$sf.ext.geom()` / `expand()` and IntersectionObserver; Radical skips the flowline CSS and format JS step |
| tag directly in the page | yes | |

Useful ad options: `singleSize: {width, height}` makes Radical lay the creative out for a
size other than the frame's, and `ad.forceRender()` re-renders it.

## Client test pages (`pages/*.html`)

A client test page is a copy of the publisher page where the ad will run: its layout, sticky
or fixed elements, and the ad slot's exact markup and CSS. It is served at
`http://localhost:3000/pages/<name>.html` and reloads on every save of `custom.js`,
`format.js` or anything in `pages/`.

- List them: `curl -s http://localhost:3000/api/pages`
- Start a new one: `curl -s http://localhost:3000/rad/templates/page.html > pages/<client>.html`
  (or `npx rad-coder --new-page=<client>`). The template explains what to measure on the
  real page.
- The ad goes in with one script tag per slot. Copy the publisher's slot markup, ids and
  classes: format JS usually finds the slot through them.

```html
<script src="/rad/harness.js"
        data-slot="#leaderboard"
        data-frame="friendly"
        data-size="4x4"
        data-flowline="400H"
        data-options='{"singleSize":{"width":600,"height":1200}}'
        data-debug-events="rad-sticky-leaderboard"></script>
```

`data-slot` (required): the element the ad goes into. `data-frame`: `friendly` (GPT
friendly iframe, default), `safeframe` (GAM SafeFrame) or `none` (tag directly in the page).
`data-size`: the ad server's iframe size. `data-flowline`: flowline id or part of its name.
`data-options`: merged into the Radical options. Optional: `data-frame-id` (copy the
publisher's iframe id) and `data-sandbox="gpt"`.

- Query parameters: `?flowline=…`, `?frame=friendly|safeframe|none`, `?noformat=1` (control
  run without format JS), `?debug=0` (hide the panel).
- `safeframe` loads the ad frame from `127.0.0.1` when the page is on `localhost` (and the
  other way round), so the frame is really cross-origin, with a `$sf.ext` shim fed by the page.
- The page gets a `rad:slot-render-ended` event (like GPT's slotRenderEnded) to do what the
  publisher's script does, e.g. remove an `is-empty` class.
- Format JS can report its state with a CustomEvent; list its name in `data-debug-events`
  to see it in the debug panel.
- Inspect from the browser tools: `window.__radHarness` holds slots, errors and events, and
  `await __radHarness.evalInFrame('return …')` runs code inside the ad frame, even a
  cross-origin SafeFrame.

On `test.html` the format JS is applied too (and its deployment-script copy runs in the
page). Open `test.html?noformat=1` to compare without it. Each format gets its own format JS:
`format.js` for the formats it belongs to, Studio's for the others. Check the formats of a
change with `test.html?flowline=<id>`.

---

# Radical API Reference for ResponsiveAds

This document outlines the specific implementation patterns and lifecycle hooks for the Radical API. Use this guide to programmatically control elements, manage dynamic data (DCO), and handle cross-window interactions in ResponsiveAds creatives.

Use this as a good starting point always call functions from `!rad.getMergedContent().inEditor` check to prevent messing up the editor code. 

```
var rad = Radical.getAdByWindow(window);
var container = rad.getContainer();

var inScreenshot = window.location.href.indexOf('preview?screenshot=1') > -1 ? true : false;


if (!rad.getMergedContent().inEditor) {
    rad.onLoad(onAdLoaded);
    rad.onBeforeRender(onBeforeRender);  
    rad.onRender(onAdRender);
    
}
function onAdLoaded() {}
function onBeforeRender(arg) {
    console.log('onBeforeRender', arg);
}
function onAdRender() {
    console.log('onAdRender');
    const el = rad.getElementById('a2');
    console.log(el);
}
```

## 1. Initializing the Controller

Every script must first reference the ad instance and its container.

```javascript
var rad = Radical.getAdByWindow(window);
var container = rad.getContainer();
```

## 2. Core Lifecycle Hooks

These hooks are critical for ensuring code executes in the correct order.

### rad.onBeforeRender(arg)

The Data Injection Layer. Runs after the config is loaded but before elements are created in the DOM.

Use for: Swapping text, images, and click-through URLs (DCO).  
Key Property: `arg.elementDefs` contains the blueprint for every element.

```javascript
rad.onBeforeRender(function(arg) {
    // Dynamically update a textbox
    arg.elementDefs.headlineID.textboxWidget.text = "Custom Value";
    
    // Update an image source
    arg.elementDefs.heroImageID.image.src = "https://example.com/image.jpg";
    
    // Update a click-through URL
    arg.elementDefs.ctaID.onClick[0].data.url = "https://landingpage.com";
});
```

### rad.onLoad(callback)

The Event Registration Layer. Runs once the ad flow is loaded.

Use for: Adding DOM event listeners (click, touchstart, window events).  
Benefit: Prevents duplicate listeners during ad resize/re-render.

```javascript
rad.onLoad(function() {
    window.addEventListener('message', function(e) { 
        console.log("External Data:", e.data); 
    });
});
```

### rad.onRender(callback)

The Post-Layout Layer. Runs after elements are physically positioned.

Use for: Initializing carousels, GSAP animations, or grabbing domNode references.  
Note: Fires multiple times on browser resize.

```javascript
rad.onRender(function() {
    var element = rad.getElementById('e1');
    if (element) {
        element.domNode.style.borderRadius = "10px";
    }
});
```

### container.onVisibilityChange(callback)

The Performance & Policy Layer.

Use for: Pausing video or audio when the ad scrolls out of view.

```javascript
container.onVisibilityChange(function(isVisible) {
    if (!isVisible) {
        // Stop all active media
        pauseAllVideo();
    }
});
```

## 3. Component Interaction

### Carousels

Access carousel-specific methods via `rad.getElementById('ID')`.

Method | Description
--- | ---
animateToSlide(index) | Smoothly transitions to a specific slide.
getVisibleSlideIndex() | Returns current index (0-based).
slideChangeCallback(fn) | Triggers a function when the slide changes.
getSlides() | Returns an array of all slide objects.

### Textbox

To update text post-render, use the helper method to ensure layout recalculation:

```javascript
var txt = rad.getElementById('text1');
txt.updateContent("New Text");
// rad.updateElementStyles handles the necessary updateShrink() internally
rad.updateElementStyles(txt.domNode, { opacity: 1 });
```

## 4. Advanced Patterns

### Dynamic Content Optimization (DCO)

Retrieve parameters passed via the Ad Tag URL or Query String:

```javascript
var options = rad.getAdTagOptions();
var dealerId = options.dealer_id || "default_001";
```

### Analytics Tracking

Trigger custom tracking events for reporting:

```javascript
rad.sendAnalyticsEvent({
    e: 'interact.scroll', 
    v: 50, // Value (e.g., 50% scrolled)
    elId: 'scrolling_container'
});
```

### Cross-Origin Detection

Check if the ad can communicate with the top-level window (parent page):

```javascript
if (!container.isCrossOrigin()) {
    var parentDoc = container.getAdWindow().top.document;
    // Safe to interact with parent window
}
```

## 5. Summary Checklist for AI Agents

- DCO logic? Use `onBeforeRender` to modify `arg.elementDefs`.
- Visual tweaks? Use `onRender` with `rad.getElementById('ID').domNode`.
- Click listeners? Use `onLoad` to prevent duplicates.
- Hiding elements? Use `rad.updateElementStyles(el, { visible: false })`.

---

# Best Practices

When it comes to best practices for using the Radical API, you should keep a few things in mind. Here are some best practices to follow.

## Use updateElementStyles

When it comes to updating the visibility of an element, you should use the `rad.updateElementStyles` method. This method is more efficient and easier to use than updating the style attribute directly. The problem with updating the style attribute directly is that for certain elements (like Textbox), you also need to call the `updateShrink()` method to make the Textbox visible. `rad.updateElementStyles` handles this for you.

---

# Components

In this guide, we will take a look at different components a creative can have and how Radical API can help you manage them.

You can add Custom JavaScript to your creatives if you want to access and control the elements added from the editor.

## Carousel

Carousels are a great way to display multiple images or videos in a single ad unit. You can use the Radical API to create and manage carousels in your creatives.

Name | Description
--- | ---
animateToSlide(index: number): void | Use this method to animate the carousel to a specific slide. The method takes a single argument, which is the index of the slide you want to animate to.
animateToSlideIndex(index: number): void | Use this method to animate the carousel to a specific slide. The method takes a single argument, which is the index of the slide you want to animate to.
getCarouselPlayUUID(): string | Use this method to get the UUID of the carousel play event.
getElementDataSource(): string | A Carousel component can have a data source. Users can add this data source from the editor. This method returns the data source of the carousel.
getSlides(): Carousel Slide[] | Use this method to get all the slides in the carousel.
getElementDataSource(): ElementDataSource | Use this method to get the data source of the carousel.
getVisibleSlideIndex(): number | Use this method to get the index of the currently visible slide.
moveToSlide(index: number): void; | Use this method to move the carousel to a specific slide. The method takes a single argument, which is the index of the slide you want to move to. This method does not animate the transition.
nextSlide(): void; | Use this method to move the carousel to the next slide. It will use the first slide if the current slide is the last one.
onRender(callback: (arg: any) => void): void; | Use this method to register a callback that will be called when the carousel is rendered.
pause(): void; | Use this method to pause the carousel.
previousSlide(): void | Use this method to move the carousel to the previous slide. It will use the last slide if the current slide is the first one.
removeSlide(index: number): void | Use this method to remove a slide from the carousel. The method takes a single argument, which is the index of the slide you want to remove.
rendered(): boolean | Use this method to check if the carousel is rendered.
resume(): void | Use this method to resume the carousel.
setPausedCarouselAfterSlideChange(paused: boolean): void | Use this method to set whether the carousel should be paused after a slide change.
setVisibleSlide(index: number): void; | Use this method to set the visible slide of the carousel. The method takes a single argument, which is the index of the slide you want to set as visible.
setVisibleSlideIndex(index: number): void; | Use this method to set the visible slide of the carousel. The method takes a single argument, which is the index of the slide you want to set as visible.
slideChangeCallback(callback: (arg: any) => void): void; | Use this method to register a callback that will be called when the slide changes.
updated(): boolean; | Use this method to check if the carousel is updated.

## TextBox

Textboxes are used to display text in your creatives. They are added from the editor but you can edit them using the API.

Name | Description
--- | ---
updateShrink(): string | Use this method to update the text element. Any changes to the text element will be reflected in the DOM.
updateContent(text: string): void | Use this method to update the content of the textbox. The method takes a single argument, which is the content you want to update.

---

# Radical API

Radical API is a set of methods and properties that you can use to manage your creatives. You can use the API to access and control the elements in your creatives.

## RAD object

Our rendering library called Radical exposes some helper functions you can you while working on your creative you can access them by initializing the `rad` object by calling

```javascript
var rad = Radical.getAdByWindow(window);
```

The majority of functions available on the object are used internally by Radical, but a couple of them will come in handy when working with the creative.

```javascript
rad.onRender(onAdRender);

function onAdRender() {
  console.log('rendered');
}
```

This is called after all the elements in the creation are rendered and positioned by the Radical. Use the onLoad event to add DOM event listeners (click, mouse enter, mouse leave, ...) because onRender is called multiple times when you resize the ad, and the listeners would be added multiple times.

```javascript
rad.onLoad(onAdLoaded);
```

This is called after the flowline for the creative was loaded but before the render. This is a good place to add any DOM event listeners, as this is called only once.

```javascript
rad.onBeforeRender(onBeforeRender);
```

This event returns elements object with all the properties it they will render. You have an option to change these properties before the rendere here. Just update the object. The object is composed of keys that are element ID-s and values that are corresponding properties.

```javascript
var sizes = rad.getMergedContent().sizes;
```

An array of all layout sizes we can render from. In the case of Fully-fluid format, this array is empty.

```javascript
var layoutSize = rad.getRenderedSize();
```

Size object of the layout currently rendering.

```javascript
var element = rad.getElementById('e2');
```

You can use `getElementById` to get an element reference, make sure you are calling this inside `onRender` callback. Check boilerplate code, for example. `getElementById` returns an object with `domNode` property pointing to actual DOM element and some other information about the element. Some elements, like the video, also contain useful functions to control the element.

---

# All Functions

You can follow the Custom JavaScript Guide to learn how to use the Radical API in your creatives.

Name | Description
--- | ---
addGlobalEventListener(event: string, callback: (arg: any) => void) | Adds a global event listener to the creative. The event listener will be triggered when the specified event occurs in the creative.
animationTime(time: number) | Sets the animation time of the creative to the specified time in milliseconds.
callTrackerURL(url: string) | Call the specified tracker URL.
clearElements(elements: HTMLElement[]) | Clears the specified elements from the creative.
condeHideAd() | Hides the creative.
createLightboxContainer() | Creates a lightbox container.
creativeTimeSpent() | Returns the time spent on the creative in milliseconds.
domEventHandler(event: string, callback: (arg: any) => void) | Adds a DOM event listener to the creative. The event listener will be triggered when the specified event occurs in the creative.
forceRender() | Forces the creative to render.
generateUUID() | Generates a UUID.
getActiveConfig() | Returns the active config of the creative.
getAdContent() | Returns the ad content of the creative.
getAdRenderer() | Returns the ad renderer of the creative.
getAdTagOptions() | Returns the ad tag options of the creative.
getAdVersion() | Returns the ad version of the creative.
getAnimationTimeline() | Returns the animation timeline of the creative.
getAssets() | Returns the assets of the creative.
getConfig() | Returns the config of the creative.
getContainer() | Returns the container of the creative.
getCookie(name: string) | Returns the value of the specified cookie.
getCurrentMediaquery() | Returns the current media query of the creative.
getDataLayer() | Returns the data layer of the creative.
getDeviceInfo() | Returns the device info of the creative.
getElementById(id: string) | Returns the element with the specified ID.
getElementChildren(element: HTMLElement) | Returns the children of the specified element.
getElementStyles(element: HTMLElement) | Returns the styles of the specified element.
getExtension(extensionType: string) | Returns the extension of the specified type.
getFormatLayouts() | Returns the format layouts of the creative.
getLbNro() | Returns the lightbox number of the creative.
getMergedContent() | Returns the merged content of the creative.
getRenderedSize() | Returns the rendered size of the creative.
getSizeFilter() | Returns the size filter of the creative.
getState() | Returns the state of the creative.
getUUID() | Returns the UUID of the creative.
getUserInfo() | Returns the user info of the creative.
getVisibleElementChildren(element: HTMLElement) | Returns the visible children of the specified element.
hideCreative() | Hides the creative.
isAdContentAvailable() | Returns true if the ad content is available, otherwise false.
isOpenStateAdObj() | Returns true if the ad object is in open state, otherwise false.
onAdContentAvailable(callback: (arg: any) => void) | Adds a callback to be triggered when the ad content is available.
onAdHover(callback: (arg: any) => void) | Adds a callback to be triggered when the ad is hovered.
onAnimationProgress(callback: (arg: any) => void) | Adds a callback to be triggered when the animation progresses.
onBeforeRender(callback: (arg: any) => void) | Adds a callback to be triggered before the creative is rendered.
onCarouselFirstSlide(callback: (arg: any) => void) | Adds a callback to be triggered when the carousel is on the first slide.
onCarouselLastSlide(callback: (arg: any) => void) | Adds a callback to be triggered when the carousel is on the last slide.
onCarouselMiddleSlide(callback: (arg: any) => void) | Adds a callback to be triggered when the carousel is on the middle slide.
onClick(callback: (arg: any) => void) | Adds a callback to be triggered when the creative is clicked.
onCountdownFinished(callback: (arg: any) => void) | Adds a callback to be triggered when the countdown finishes.
onElementHover(callback: (arg: any) => void) | Adds a callback to be triggered when an element is hovered.
onElementMouseOut(callback: (arg: any) => void) | Adds a callback to be triggered when the mouse leaves an element.
onLoad(callback: (arg: any) => void) | Adds a callback to be triggered when the creative is loaded.
onMediaEnded(callback: (arg: any) => void) | Adds a callback to be triggered when the media ends.
onMediaPause(callback: (arg: any) => void) | Adds a callback to be triggered when the media is paused.
onMediaPlaying(callback: (arg: any) => void) | Adds a callback to be triggered when the media is playing.
onPreviewVideoEnd(callback: (arg: any) => void) | Adds a callback to be triggered when the preview video ends.
onPreviewVideoStart(callback: (arg: any) => void) | Adds a callback to be triggered when the preview video starts.
onRender(callback: (arg: any) => void) | Adds a callback to be triggered when the creative is rendered.
onVideoEnd(callback: (arg: any) => void) | Adds a callback to be triggered when the video ends.
onVideoMuted(callback: (arg: any) => void) | Adds a callback to be triggered when the video is muted.
onVideoPause(callback: (arg: any) => void) | Adds a callback to be triggered when the video is paused.
onVideoPlay(callback: (arg: any) => void) | Adds a callback to be triggered when the video is played.
onVideoTimeUpdate(callback: (arg: any) => void) | Adds a callback to be triggered when the video time is updated.
onVideoUnMuted(callback: (arg: any) => void) | Adds a callback to be triggered when the video is unmuted.
onVideoUnableToAutoplay(callback: (arg: any) => void) | Adds a callback to be triggered when the video is unable to autoplay.
pauseAnimation() | Pauses the animation of the creative.
playAnimation() | Plays the animation of the creative.
previewPageForceRender() | Forces the creative to render the preview page.
refreshInteractionDisable() | Disables the refresh interaction of the creative.
removeGlobalEventListener(event: string, callback: (arg: any) => void) | Removes the specified global event listener from the creative.
renderElement(element: HTMLElement) | Renders the specified element in the creative.
renderElementWithStyles(element: HTMLElement, styles: any) | Renders the specified element in the creative with the specified styles.
restartAnimation() | Restarts the animation of the creative.
seekAnimation(time: number) | Seeks the animation of the creative to the specified time in milliseconds.
sendAdformAnalyticsEvent(event: string, data: any) | Sends an Adform analytics event with the specified event and data.
sendAnalyticsEvent(event: string) | Sends an analytics event with the specified event.
setConfig(config: any) | Sets the config of the creative to the specified config.
setCookie(name: string, value: string, options: any) | Sets the specified cookie with the specified value and options.
setCustomTracker(tracker: any) | Sets the custom tracker of the creative to the specified tracker.
setLbNro(nro: number) | Sets the lightbox number of the creative to the specified number.
setProgressAnimation(progress: number) | Sets the progress of the animation of the creative to the specified progress.
setResponsiveMode(mode: string) | Sets the responsive mode of the creative to the specified mode.
setSizeFilter(filter: any) | Sets the size filter of the creative to the specified filter.
setState(state: any) | Sets the state of the creative to the specified state.
setVideoInViewPercetage(percentage: number) | Sets the percentage of the video in view to the specified percentage.
start() | Starts the creative.
startAnimation() | Starts the animation of the creative.
stopAnimation() | Stops the animation of the creative.
updateAgTagOptions(options: any) | Updates the ad tag options of the creative to the specified options.
updateAnimationTimeline(timeline: any, time: number) | Updates the animation timeline of the creative to the specified timeline and time.
updateCustomCSS(css: string) | Updates the custom CSS of the creative to the specified CSS.
updateCustomJs(js: string) | Updates the custom JavaScript of the creative to the specified JavaScript.
updateElementStyles(element: HTMLElement, styles: any) | Updates the styles of the specified element to the specified styles.

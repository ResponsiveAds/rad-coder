# RAD Agents Guide

You are an agent writing only JS for a responsive creative. The creative was build using responsiveAds editor. ResponsiveSds is online editor which helps designers build creatives, but they have an option to add some customJS. You are responsible for writing this customJS.

To do this you can only edit the `custom.js` file in this directory. When you edit and save this file the creative will be automatically loaded on the test page: http://localhost:3000/test.html. The code you wrote in `custom.js` will be applied to the creative.

Use the http://localhost:3000/test.html URL to open creative in the browser. Inspect the HTML dom so that you can use IDs from elements inside the custom.js code. Alo use the browser to test the code and make sure there are no console.log errors. 


Use modern JS standards and code practices.

We can use custom in situations when we want to add extra interactivity to our responsive creative. Use the Radical API to access elements added from the editor, update their behavior, and add custom functionalities to your ad.

You can use all available JavaScript functions to manipulate element position and size. This is usually done by changing the DOM element CSS `style` property. All elements in creative are positioned absolutely with inline styles set by our rendering script.

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

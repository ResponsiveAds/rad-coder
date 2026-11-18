//# sourceURL=RAD.js
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

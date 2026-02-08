/**
 * [CustomJS] Ad Creative
 * Animates the QR code image in from the right side after the creative loads.
 */

(function () {
  'use strict';

  var rad = Radical.getAdByWindow(window);
  var animated = false;

  rad.onRender(function () {
    var qrElement = rad.getElementById('f5');
    if (!qrElement || !qrElement.domNode) return;

    var node = qrElement.domNode;

    if (!animated) {
      animated = true;

      // Read the original transform set by Radical (e.g. "translateX(-50%)")
      var originalTransform = getComputedStyle(node).transform || node.style.transform;

      // Start off-screen to the right
      node.style.transition = 'none';
      node.style.transform = 'translateX(100%)';
      node.style.opacity = '0';

      // Force reflow so the start position takes effect
      void node.offsetWidth;

      // Animate to original position
      node.style.transition = 'transform 0.8s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.8s ease';
      setTimeout(function () {
        node.style.transform = originalTransform;
        node.style.opacity = '1';
      }, 300);
    }
  });
})();

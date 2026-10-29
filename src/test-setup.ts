/**
 * Test environment, set before any component mounts.
 *
 * React 19 checks this flag to decide whether it may batch updates inside
 * `act`. A test that mounts a component without it still passes, but React
 * warns on every render and the batching that makes the assertions
 * deterministic silently stops applying — so a green run would prove less
 * than it looks like.
 */
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom implements layout as zeroes and has no scrolling at all.
 *
 * `scrollTo` is real in every browser this app runs in, so the screen calls it
 * unguarded. Stubbing it here keeps the production code honest rather than
 * adding a `typeof list.scrollTo === "function"` branch that no device needs.
 */
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

/**
 * jsdom has no object URLs. The composer creates one for an image preview and
 * revokes it when the image leaves; production WebViews implement both.
 */
if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:test";
}
if (!URL.revokeObjectURL) {
  URL.revokeObjectURL = () => {};
}

export {};
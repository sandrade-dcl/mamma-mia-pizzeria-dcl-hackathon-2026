// Hito 4 — Option A: masa is fully server-owned. The server spawns the
// dough, runs the click counter, transitions to FlatDough, and animates
// the visual squash via Transform.scale. The client used to track its own
// `currentPizza` here and wire onKnead/onSendClick callbacks — all of that
// moved into `src/server/kitchen.ts`. Click dispatch on the synced pizza
// happens in `pizzaSync.ts`.

export function setupMasaStation(): void {
  // Nothing to do on the client — the dough is server-spawned, the click
  // handler is attached by pizzaSync.ts when the pizza first appears.
}

export function resetMasaStation(): void {
  // Round resets are server-driven. Pizzas removed by the server propagate
  // to clients via CRDT; clients have no local state to wipe here.
}

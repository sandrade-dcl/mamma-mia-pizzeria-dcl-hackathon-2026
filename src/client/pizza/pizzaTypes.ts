import { Schemas, engine } from '@dcl/sdk/ecs'
import { AUTH_SERVER_PEER_ID } from '@dcl/sdk/network/message-bus-sync'

export enum PizzaStep {
  RawDough = 0,
  FlatDough = 1,
  Topped = 2,
  Baking = 3,
  Perfect = 4,
  Burnt = 5
}

export enum Topping {
  Tomato = 0,
  Mozzarella = 1,
  Salami = 2,
  Mushroom = 3
}

// The authoritative pizza component, owned by the server (Hito 4 Option A).
//
//   • step / toppings / bakeStartTime / doughClicks — pizza state machine,
//     mutated by the server in response to client Cmd* messages.
//   • currentStation — which station owns the pizza right now (also covers
//     the in-flight conveyor segments). Clients dispatch a different Cmd*
//     depending on this field plus `step`.
//   • disposing / disposingStartTime — set by the server when a pizza is
//     about to be removed (discard or successful serve). Clients observe
//     the field flipping and run the local visual animation; the server
//     actually despawns the entity once the corresponding visual duration
//     has elapsed (so the animation plays on every client first).
//   • syncId — mirror of the syncEntity ID the server allocated for this
//     pizza. Clients copy it into Cmd* payloads so the server can find the
//     entity again without trusting client-local entity IDs.
export const PizzaState = engine.defineComponent('mammamia::PizzaState', {
  step: Schemas.Int,
  toppings: Schemas.Array(Schemas.Int),
  // Timestamps are stored as ms-since-epoch in Int64. Schemas.Float is
  // float32, which loses millisecond precision for values around 1.7e9
  // (the current Unix timestamp range) — a write of 1747958400.5 would
  // round to ~1747958400 or ~1747958528, breaking elapsed-time math and
  // making conveyor segments teleport instead of animating.
  bakeStartTime: Schemas.Int64,
  doughClicks: Schemas.Int,
  currentStation: Schemas.Int,
  // ms-since-epoch when the current station was entered. Clients lerp
  // Transform.position deterministically from the matching path waypoints
  // based on `Date.now() - stationStartTime` — no Transform sync is needed
  // (and avoiding it dodges CRDT throttling, which is what made the
  // conveyor look chunky in earlier iterations).
  stationStartTime: Schemas.Int64,
  // Which of the four delivery counter slots the server assigned. Only
  // meaningful when currentStation === Delivery.
  deliverySlotIdx: Schemas.Int,
  disposing: Schemas.Int,
  syncId: Schemas.Int
})

// Server is the only legal writer. Custom-component validation is global,
// no per-entity registration needed.
PizzaState.validateBeforeChange((value) =>
  value.senderAddress.toLowerCase() === AUTH_SERVER_PEER_ID.toLowerCase()
)

export const MASA_CLICKS_REQUIRED = 3
export const BAKE_TIME_PERFECT = 5
export const BAKE_TIME_BURNT = 9

import { Schemas, engine } from '@dcl/sdk/ecs'
import { AUTH_SERVER_PEER_ID } from '@dcl/sdk/network/message-bus-sync'

// ------------------------------------------------------------------------
// Crazy Pizza! authoritative state — shared component definitions.
//
// The server is the single writer for every component here. Clients read,
// the HUD reflects, and any change comes from a message sent up to the
// server (StartRound, AttemptServe, AddScore, …). validateBeforeChange is
// installed at module load — on the client it is a no-op, on the server it
// drops any incoming update that wasn't signed by the auth server.
// ------------------------------------------------------------------------

// Numeric enum so we can stuff the round phase into a Schemas.Int and avoid
// string comparisons on the hot path. Stays bit-identical to the original
// 'idle' | 'playing' | 'end' contract.
export enum RoundPhase {
  Idle = 0,
  Playing = 1,
  End = 2
}

// Where the pizza lives right now. Steady stations (Masa/Toppings/HornoFront/
// Horno/Delivery) are the ones the player can click on; the *To* variants
// are in-flight conveyor segments where clicks should do nothing. The Horno
// pair separates the "mouth of the oven" (player needs to insert) from
// inside the oven (baking); HornoFrontToHorno is the brief insert slide.
export enum CurrentStation {
  Masa = 0,
  MasaToToppings = 1,
  Toppings = 2,
  ToppingsToHorno = 3,
  HornoFront = 4,
  HornoFrontToHorno = 8,
  Horno = 5,
  HornoToDelivery = 6,
  Delivery = 7
}

// The server marks a pizza as disposing right before it removes the entity.
// Clients use the value to pick which local animation to play; the field
// flips back to None only because the entity itself disappears.
export enum DisposingState {
  None = 0,
  Discard = 1,
  Serve = 2
}

// Visual durations the server waits between flipping `disposing` and
// actually removing the entity — clients run the matching animation in
// `pizzaVisual.ts` for these exact durations.
export const DISPOSING_DISCARD_DURATION_MS = 400
export const DISPOSING_SERVE_DURATION_MS = 800

// Singleton — one entity holds the whole round summary. Stored as a single
// component for simplicity since the four fields almost always update at the
// same time (round start, round end, score delta from a serve).
export const RoundState = engine.defineComponent('mamma::round', {
  phase: Schemas.Int,
  roundEndsAt: Schemas.Int64,
  score: Schemas.Int,
  bestScore: Schemas.Int
})

// One entity per ticket slot. `active=false` means the slot is "Waiting for
// order…" on the HUD. `expiredSince` is the timestamp the server marked the
// ticket as expired (0 if it's still live); the HUD uses it to flash the
// card red for ~1.5s before the server clears the slot.
export const OrderSlot = engine.defineComponent('mamma::orderSlot', {
  slotIndex: Schemas.Int,
  active: Schemas.Boolean,
  id: Schemas.Int,
  recipeIndex: Schemas.Int,
  createdAt: Schemas.Int64,
  expiresAt: Schemas.Int64,
  expiredSince: Schemas.Int64
})

// Top-N team scores, sorted descending. Persisted to Storage by the
// server on every round end and broadcast to all clients via the usual
// component sync. Each entry pairs a player display label (the
// truncated wallet address of whoever started the round) with their
// best score across rounds.
export const LEADERBOARD_MAX = 10

export const Leaderboard = engine.defineComponent('mamma::leaderboard', {
  entries: Schemas.Array(Schemas.Map({ name: Schemas.String, score: Schemas.Int }))
})

// Server-only writes for both. Custom components use global validation, no
// per-entity registration needed.
const serverOnly = (value: { senderAddress: string }): boolean =>
  value.senderAddress.toLowerCase() === AUTH_SERVER_PEER_ID.toLowerCase()

RoundState.validateBeforeChange(serverOnly)
OrderSlot.validateBeforeChange(serverOnly)
Leaderboard.validateBeforeChange(serverOnly)

// Stable numeric IDs for syncEntity so both sides agree on which entity is
// which singleton. 100 is well above the user-entity base (512) in the
// composite but well above the engine reserved range (0-2) too.
export enum SyncIds {
  RoundState = 100,
  OrderSlot0 = 101,
  OrderSlot1 = 102,
  OrderSlot2 = 103,
  Leaderboard = 104
}

export const ORDER_SLOT_SYNC_IDS: SyncIds[] = [
  SyncIds.OrderSlot0,
  SyncIds.OrderSlot1,
  SyncIds.OrderSlot2
]

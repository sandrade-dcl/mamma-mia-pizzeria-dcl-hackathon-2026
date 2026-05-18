import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

// ------------------------------------------------------------------------
// Mamma Mia's network messages — typed schemas registered at module load.
//
// Convention:
//   • Cmd*  — client → server requests for an authoritative action
//   • Evt*  — server → client broadcasts that don't fit a synced component
//             (per-player feedback, transient rejections).
//
// Pizza identification: clients reference each pizza by the `syncId` the
// server allocated for it (mirrored in PizzaState.syncId). That way the
// server can resolve to its local Entity without trusting per-client
// entity IDs.
// ------------------------------------------------------------------------

export const Messages = {
  // Round state machine. Anyone in the scene can request — the server is
  // idempotent (Idle ↔ Playing ↔ End transitions ignore no-op writes).
  CmdStartRound: Schemas.Map({}),
  CmdQuitRound: Schemas.Map({}),
  CmdBackToIdle: Schemas.Map({}),

  // Pizza interactions — every action goes through the server.
  CmdKnead: Schemas.Map({ pizzaSyncId: Schemas.Int }),
  CmdSendToToppings: Schemas.Map({ pizzaSyncId: Schemas.Int }),
  // Toppings ingredient: the server picks "the pizza currently at the
  // toppings station" — the client doesn't need to identify a specific
  // pizza because only one can sit on toppings at a time.
  CmdAddTopping: Schemas.Map({ topping: Schemas.Int }),
  CmdSendToHorno: Schemas.Map({ pizzaSyncId: Schemas.Int }),
  CmdInsertHorno: Schemas.Map({ pizzaSyncId: Schemas.Int }),
  CmdSendToDelivery: Schemas.Map({ pizzaSyncId: Schemas.Int }),
  CmdDiscard: Schemas.Map({ pizzaSyncId: Schemas.Int }),
  CmdAttemptServe: Schemas.Map({ pizzaSyncId: Schemas.Int }),

  // Per-player ACK for a serve attempt. ok=true means the server credited
  // points and is starting the serve animation; ok=false means no matching
  // (live) order — the pizza stays on the counter.
  EvtServeResult: Schemas.Map({
    ok: Schemas.Boolean,
    scoreDelta: Schemas.Int,
    pizzaSyncId: Schemas.Int
  }),
  // Per-player feedback when the server rejected a Cmd* because the
  // destination station is busy (or some other invariant blocked the
  // action). Client renders the reason as floating text on the pizza.
  EvtActionRejected: Schemas.Map({
    reason: Schemas.String,
    pizzaSyncId: Schemas.Int
  })
}

export const room = registerMessages(Messages)

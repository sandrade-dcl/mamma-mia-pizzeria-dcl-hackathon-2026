import { Entity, PlayerIdentityData, engine, executeTask } from '@dcl/sdk/ecs'
import { syncEntity } from '@dcl/sdk/network'
import { Storage } from '@dcl/sdk/server'
import {
  EXPIRED_DISPLAY_MS,
  FINAL_GENERATION_INTERVAL_MS,
  GENERATION_RAMP_DURATION_MS,
  INITIAL_GENERATION_INTERVAL_MS,
  RECIPES,
  TICKET_LIFETIME_MS
} from '../client/orders/orderTypes'
import { SCORE_EXPIRED_TICKET } from '../client/scoring'
import { room } from '../shared/messages'
import {
  LEADERBOARD_MAX,
  Leaderboard,
  ORDER_SLOT_SYNC_IDS,
  OrderSlot,
  RoundPhase,
  RoundState,
  SyncIds
} from '../shared/syncedState'
import {
  handleAddTopping,
  handleAttemptServe,
  handleDiscard,
  handleInsertHorno,
  handleKnead,
  handleSendToDelivery,
  handleSendToHorno,
  handleSendToToppings,
  initKitchen,
  onRoundEnd,
  onRoundStart
} from './kitchen'

// ------------------------------------------------------------------------
// Authoritative server (Hito 4 — Option A).
//
// Owns: round state, order generation/expiry, scoring, leaderboard
// persistence, AND the kitchen state machine (pizzas, conveyor, baking,
// discard/serve disposal). Every Cmd* from the client funnels through
// here; clients never mutate authoritative state directly.
// ------------------------------------------------------------------------

const ROUND_DURATION_MS = 4 * 60 * 1000
const LEADERBOARD_STORAGE_KEY = 'leaderboard'

let ROUND_SINGLETON: Entity = 0 as Entity
let LEADERBOARD_SINGLETON: Entity = 0 as Entity
const orderSlotEntities: Entity[] = []

let generationStartedAt = 0
let lastGenerationAt = 0
let nextOrderId = 1

export function initServer() {
  console.log('[SERVER] Mamma Mia\'s Pizzeria — booting authoritative server (Hito 4)')

  ROUND_SINGLETON = engine.addEntity()
  RoundState.create(ROUND_SINGLETON, {
    phase: RoundPhase.Idle,
    roundEndsAt: 0,
    score: 0,
    bestScore: 0
  })
  syncEntity(ROUND_SINGLETON, [RoundState.componentId], SyncIds.RoundState)

  for (let i = 0; i < ORDER_SLOT_SYNC_IDS.length; i++) {
    const e = engine.addEntity()
    OrderSlot.create(e, {
      slotIndex: i,
      active: false,
      id: 0,
      recipeIndex: 0,
      createdAt: 0,
      expiresAt: 0,
      expiredSince: 0
    })
    syncEntity(e, [OrderSlot.componentId], ORDER_SLOT_SYNC_IDS[i])
    orderSlotEntities.push(e)
  }

  LEADERBOARD_SINGLETON = engine.addEntity()
  Leaderboard.create(LEADERBOARD_SINGLETON, { scores: [] })
  syncEntity(LEADERBOARD_SINGLETON, [Leaderboard.componentId], SyncIds.Leaderboard)
  executeTask(async () => {
    try {
      const saved = await Storage.get<{ scores: number[] }>(LEADERBOARD_STORAGE_KEY)
      if (saved && Array.isArray(saved.scores)) {
        const lb = Leaderboard.getMutable(LEADERBOARD_SINGLETON)
        lb.scores = saved.scores.slice(0, LEADERBOARD_MAX)
        console.log(`[SERVER] leaderboard loaded (${lb.scores.length} entries)`)
      }
    } catch (err) {
      console.log(`[SERVER] leaderboard load failed: ${String(err)}`)
    }
  })

  initKitchen()

  // Round state machine
  room.onMessage('CmdStartRound', () => startRoundServerSide())
  room.onMessage('CmdQuitRound', () => endRoundServerSide())
  room.onMessage('CmdBackToIdle', () => backToIdleServerSide())

  // Pizza interactions — delegate to the kitchen module
  room.onMessage('CmdKnead', (data, ctx) => handleKnead(data.pizzaSyncId, ctx?.from))
  room.onMessage('CmdSendToToppings', (data, ctx) =>
    handleSendToToppings(data.pizzaSyncId, ctx?.from)
  )
  room.onMessage('CmdAddTopping', (data, ctx) => handleAddTopping(data.topping, ctx?.from))
  room.onMessage('CmdSendToHorno', (data, ctx) => handleSendToHorno(data.pizzaSyncId, ctx?.from))
  room.onMessage('CmdInsertHorno', (data, ctx) => handleInsertHorno(data.pizzaSyncId, ctx?.from))
  room.onMessage('CmdSendToDelivery', (data, ctx) =>
    handleSendToDelivery(data.pizzaSyncId, ctx?.from)
  )
  room.onMessage('CmdDiscard', (data, ctx) => handleDiscard(data.pizzaSyncId, ctx?.from))
  room.onMessage('CmdAttemptServe', (data, ctx) =>
    handleAttemptServe(data.pizzaSyncId, ctx?.from)
  )

  engine.addSystem(roundTimerSystem)
  engine.addSystem(orderGenerationSystem)
  engine.addSystem(playerPresenceSystem)
}

// ------------------------------------------------------------------------
// Round state machine
// ------------------------------------------------------------------------

function startRoundServerSide() {
  const round = RoundState.getMutable(ROUND_SINGLETON)
  if (round.phase === RoundPhase.Playing) return
  round.phase = RoundPhase.Playing
  round.score = 0
  round.roundEndsAt = Date.now() + ROUND_DURATION_MS

  generationStartedAt = Date.now()
  lastGenerationAt = Date.now() - INITIAL_GENERATION_INTERVAL_MS + 1500
  nextOrderId = 1
  clearAllSlots()

  onRoundStart()
  console.log('[SERVER] round started')
}

function endRoundServerSide() {
  const round = RoundState.getMutable(ROUND_SINGLETON)
  if (round.phase !== RoundPhase.Playing) return
  if (round.score > round.bestScore) round.bestScore = round.score
  round.phase = RoundPhase.End
  clearAllSlots()
  onRoundEnd()
  recordLeaderboardScore(round.score)
  console.log(`[SERVER] round ended — score ${round.score}, best ${round.bestScore}`)
}

function backToIdleServerSide() {
  const round = RoundState.getMutable(ROUND_SINGLETON)
  if (round.phase === RoundPhase.Idle) return
  round.phase = RoundPhase.Idle
  clearAllSlots()
  onRoundEnd()
}

function recordLeaderboardScore(score: number) {
  if (score <= 0) return
  const lb = Leaderboard.getMutable(LEADERBOARD_SINGLETON)
  const updated = [...lb.scores, score].sort((a, b) => b - a).slice(0, LEADERBOARD_MAX)
  lb.scores = updated
  executeTask(async () => {
    try {
      await Storage.set(LEADERBOARD_STORAGE_KEY, { scores: updated })
    } catch (err) {
      console.log(`[SERVER] leaderboard save failed: ${String(err)}`)
    }
  })
}

function roundTimerSystem(_dt: number) {
  const round = RoundState.getOrNull(ROUND_SINGLETON)
  if (!round || round.phase !== RoundPhase.Playing) return
  if (Date.now() >= round.roundEndsAt) endRoundServerSide()
}

// The auth server is a long-lived process; reloading or rejoining the
// scene keeps it alive with whatever state the previous session left
// behind. To give solo players (and dev-loop testers) a clean restart,
// we reset to Idle the moment the connected-player count transitions
// from 0 to 1. With multiple players already in the scene the reset
// doesn't fire, so a reconnecting player rejoins the ongoing round
// instead of wiping it.
let lastPlayerCount = 0

function playerPresenceSystem(_dt: number) {
  let count = 0
  for (const [_entity] of engine.getEntitiesWith(PlayerIdentityData)) {
    void _entity
    count++
  }
  if (count > 0 && lastPlayerCount === 0) {
    console.log('[SERVER] first player connected — resetting state to Idle')
    backToIdleServerSide()
  }
  lastPlayerCount = count
}

// ------------------------------------------------------------------------
// Order generation + expiry — unchanged from earlier Hito 4 wiring
// ------------------------------------------------------------------------

function clearAllSlots() {
  for (const e of orderSlotEntities) {
    const slot = OrderSlot.getMutable(e)
    slot.active = false
    slot.id = 0
    slot.recipeIndex = 0
    slot.createdAt = 0
    slot.expiresAt = 0
    slot.expiredSince = 0
  }
}

function currentGenerationInterval(): number {
  const elapsed = Date.now() - generationStartedAt
  const ramp = Math.min(1, elapsed / GENERATION_RAMP_DURATION_MS)
  return (
    INITIAL_GENERATION_INTERVAL_MS +
    (FINAL_GENERATION_INTERVAL_MS - INITIAL_GENERATION_INTERVAL_MS) * ramp
  )
}

function findEmptySlotEntity(): Entity | null {
  for (const e of orderSlotEntities) {
    const slot = OrderSlot.getOrNull(e)
    if (slot && !slot.active) return e
  }
  return null
}

function spawnOrder() {
  const slotEntity = findEmptySlotEntity()
  if (slotEntity === null) return
  const recipeIndex = Math.floor(Math.random() * RECIPES.length)
  const now = Date.now()
  const slot = OrderSlot.getMutable(slotEntity)
  slot.active = true
  slot.id = nextOrderId++
  slot.recipeIndex = recipeIndex
  slot.createdAt = now
  slot.expiresAt = now + TICKET_LIFETIME_MS
  slot.expiredSince = 0
  console.log(`[SERVER] new order: ${RECIPES[recipeIndex].displayName} (slot ${slot.slotIndex})`)
}

function orderGenerationSystem(_dt: number) {
  const round = RoundState.getOrNull(ROUND_SINGLETON)
  if (!round || round.phase !== RoundPhase.Playing) return
  const now = Date.now()

  let expiredCount = 0
  for (const e of orderSlotEntities) {
    const slot = OrderSlot.getMutable(e)
    if (!slot.active) continue
    if (slot.expiredSince !== 0) {
      if (now - slot.expiredSince >= EXPIRED_DISPLAY_MS) {
        slot.active = false
        slot.id = 0
        slot.recipeIndex = 0
        slot.createdAt = 0
        slot.expiresAt = 0
        slot.expiredSince = 0
      }
      continue
    }
    if (slot.expiresAt <= now) {
      slot.expiredSince = now
      expiredCount++
      console.log(
        `[SERVER] order expired: ${RECIPES[slot.recipeIndex].displayName} (${SCORE_EXPIRED_TICKET})`
      )
    }
  }
  if (expiredCount > 0) {
    const r = RoundState.getMutable(ROUND_SINGLETON)
    r.score += expiredCount * SCORE_EXPIRED_TICKET
  }

  if (now - lastGenerationAt >= currentGenerationInterval()) {
    spawnOrder()
    lastGenerationAt = now
  }
}

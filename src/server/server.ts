import { Entity, PlayerIdentityData, engine, executeTask } from '@dcl/sdk/ecs'
import { syncEntity } from '@dcl/sdk/network'
import { getPlayer } from '@dcl/sdk/players'
import { Storage } from '@dcl/sdk/server'
import {
  EXPIRED_DISPLAY_MS,
  FINAL_GENERATION_INTERVAL_MS,
  FINAL_MINUTE_THRESHOLD_MS,
  GENERATION_RAMP_DURATION_MS,
  INITIAL_GENERATION_INTERVAL_MS,
  RECIPES,
  TICKET_LIFETIME_FINAL_MINUTE_MS,
  TICKET_LIFETIME_MS
} from '../client/orders/orderTypes'
import { SCORE_EXPIRED_TICKET } from '../client/scoring'
import { room } from '../shared/messages'
import {
  LEADERBOARD_MAX,
  LOBBY_MAX_PLAYERS,
  Leaderboard,
  Lobby,
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
let LOBBY_SINGLETON: Entity = 0 as Entity
const orderSlotEntities: Entity[] = []
// Snapshot of the lobby at round-start: every member gets a leaderboard
// entry under their avatar name when the round ends. Captured here so
// that a player disconnecting mid-round still gets attribution.
let roundParticipants: { address: string; name: string }[] = []

let generationStartedAt = 0
let lastGenerationAt = 0
let nextOrderId = 1

export function initServer() {
  console.log('[SERVER] Crazy Pizza! — booting authoritative server (Hito 4)')

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
  Leaderboard.create(LEADERBOARD_SINGLETON, { entries: [] })
  syncEntity(LEADERBOARD_SINGLETON, [Leaderboard.componentId], SyncIds.Leaderboard)

  LOBBY_SINGLETON = engine.addEntity()
  Lobby.create(LOBBY_SINGLETON, { host: '', players: [] })
  syncEntity(LOBBY_SINGLETON, [Lobby.componentId], SyncIds.Lobby)
  executeTask(async () => {
    try {
      const saved = await Storage.get<{ entries?: { name: string; score: number }[] }>(
        LEADERBOARD_STORAGE_KEY
      )
      if (saved && Array.isArray(saved.entries) && saved.entries.length > 0) {
        const entries = saved.entries.slice(0, LEADERBOARD_MAX)
        const lb = Leaderboard.getMutable(LEADERBOARD_SINGLETON)
        lb.entries = entries
        console.log(`[SERVER] leaderboard loaded (${entries.length} entries)`)
      } else if (saved) {
        // Any other shape (e.g. legacy `scores: number[]` from early Hito 4
        // builds) is stale junk — overwrite once with a clean empty store.
        await Storage.set(LEADERBOARD_STORAGE_KEY, { entries: [] })
        console.log('[SERVER] leaderboard storage cleared (legacy/empty format)')
      }
    } catch (err) {
      console.log(`[SERVER] leaderboard load failed: ${String(err)}`)
    }
  })

  initKitchen()

  // Lobby management — only meaningful during Idle.
  room.onMessage('CmdCreateGame', (_data, ctx) => {
    if (!ctx?.from) return
    if (!isIdle()) return
    const lobby = Lobby.getMutable(LOBBY_SINGLETON)
    if (lobby.host !== '') return
    lobby.host = ctx.from
    lobby.players = [ctx.from]
    console.log(`[SERVER] lobby created by ${shortenAddress(ctx.from)}`)
  })
  room.onMessage('CmdJoinLobby', (_data, ctx) => {
    if (!ctx?.from) return
    if (!isIdle()) return
    const lobby = Lobby.getMutable(LOBBY_SINGLETON)
    if (lobby.host === '') return
    if (lobby.players.includes(ctx.from)) return
    if (lobby.players.length >= LOBBY_MAX_PLAYERS) return
    lobby.players = [...lobby.players, ctx.from]
    console.log(`[SERVER] ${shortenAddress(ctx.from)} joined lobby (${lobby.players.length}/${LOBBY_MAX_PLAYERS})`)
  })
  room.onMessage('CmdLeaveLobby', (_data, ctx) => {
    if (!ctx?.from) return
    if (!isIdle()) return
    removeFromLobby(ctx.from)
  })

  // Round state machine. Only the host may start; anyone in the lobby
  // (or end-screen) may quit / dismiss back to Idle.
  room.onMessage('CmdStartRound', (_data, ctx) => {
    if (!ctx?.from) return
    if (!isIdle()) return
    const lobby = Lobby.getOrNull(LOBBY_SINGLETON)
    if (!lobby || lobby.host !== ctx.from || lobby.players.length === 0) return
    roundParticipants = lobby.players.map((addr) => {
      const player = getPlayer({ userId: addr })
      const name = player?.name && player.name.length > 0 ? player.name : shortenAddress(addr)
      return { address: addr, name }
    })
    startRoundServerSide()
  })
  room.onMessage('CmdQuitRound', () => endRoundServerSide())
  room.onMessage('CmdBackToIdle', () => backToIdleServerSide())

  // Pizza interactions — delegate to the kitchen module, but only
  // accept commands from players who are part of the current round.
  room.onMessage('CmdKnead', (data, ctx) => {
    if (!isRoundParticipant(ctx?.from)) return
    handleKnead(data.pizzaSyncId, ctx?.from)
  })
  room.onMessage('CmdSendToToppings', (data, ctx) => {
    if (!isRoundParticipant(ctx?.from)) return
    handleSendToToppings(data.pizzaSyncId, ctx?.from)
  })
  room.onMessage('CmdAddTopping', (data, ctx) => {
    if (!isRoundParticipant(ctx?.from)) return
    handleAddTopping(data.topping, ctx?.from)
  })
  room.onMessage('CmdSendToHorno', (data, ctx) => {
    if (!isRoundParticipant(ctx?.from)) return
    handleSendToHorno(data.pizzaSyncId, ctx?.from)
  })
  room.onMessage('CmdInsertHorno', (data, ctx) => {
    if (!isRoundParticipant(ctx?.from)) return
    handleInsertHorno(data.pizzaSyncId, ctx?.from)
  })
  room.onMessage('CmdSendToDelivery', (data, ctx) => {
    if (!isRoundParticipant(ctx?.from)) return
    handleSendToDelivery(data.pizzaSyncId, ctx?.from)
  })
  room.onMessage('CmdDiscard', (data, ctx) => {
    if (!isRoundParticipant(ctx?.from)) return
    handleDiscard(data.pizzaSyncId, ctx?.from)
  })
  room.onMessage('CmdAttemptServe', (data, ctx) => {
    if (!isRoundParticipant(ctx?.from)) return
    handleAttemptServe(data.pizzaSyncId, ctx?.from)
  })

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
  clearLobby()
  roundParticipants = []
  if (round.phase === RoundPhase.Idle) return
  round.phase = RoundPhase.Idle
  clearAllSlots()
  onRoundEnd()
}

function isIdle(): boolean {
  const round = RoundState.getOrNull(ROUND_SINGLETON)
  return !!round && round.phase === RoundPhase.Idle
}

function isRoundParticipant(addr: string | undefined): boolean {
  if (!addr) return false
  return roundParticipants.some((p) => p.address === addr)
}

function clearLobby() {
  const lobby = Lobby.getMutable(LOBBY_SINGLETON)
  if (lobby.host === '' && lobby.players.length === 0) return
  lobby.host = ''
  lobby.players = []
}

function removeFromLobby(addr: string) {
  const lobby = Lobby.getMutable(LOBBY_SINGLETON)
  if (lobby.host === addr) {
    // Host leaving disbands the lobby entirely.
    clearLobby()
    console.log(`[SERVER] host ${shortenAddress(addr)} left — lobby disbanded`)
    return
  }
  if (!lobby.players.includes(addr)) return
  lobby.players = lobby.players.filter((p) => p !== addr)
  console.log(`[SERVER] ${shortenAddress(addr)} left lobby (${lobby.players.length}/${LOBBY_MAX_PLAYERS})`)
}

function shortenAddress(addr: string): string {
  if (!addr) return 'Anonymous'
  if (addr.length <= 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function recordLeaderboardScore(score: number) {
  if (roundParticipants.length === 0) return
  const lb = Leaderboard.getMutable(LEADERBOARD_SINGLETON)
  // Best-score-per-player semantics applied to each participant of the
  // round: keep at most one entry per display name, and only replace it
  // when the new shared team score is strictly higher than what was
  // already recorded for that player.
  let updated = [...lb.entries]
  let changed = false
  for (const participant of roundParticipants) {
    const name = participant.name
    const existing = updated.find((e) => e.name === name)
    if (existing && existing.score >= score) {
      console.log(`[SERVER] leaderboard skip (${name} already at ${existing.score} >= ${score})`)
      continue
    }
    updated = updated.filter((e) => e.name !== name).concat({ name, score })
    changed = true
    console.log(`[SERVER] leaderboard updated (${name}: ${score})`)
  }
  if (!changed) return
  updated = updated.sort((a, b) => b.score - a.score).slice(0, LEADERBOARD_MAX)
  lb.entries = updated
  executeTask(async () => {
    try {
      await Storage.set(LEADERBOARD_STORAGE_KEY, { entries: updated })
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
  // Collect addresses of everyone currently connected, so we can both
  // count them and detect anyone who used to be in the lobby but has
  // since left the scene.
  const connected = new Set<string>()
  for (const [entity] of engine.getEntitiesWith(PlayerIdentityData)) {
    const id = PlayerIdentityData.getOrNull(entity)
    if (id?.address) connected.add(id.address)
  }
  const count = connected.size
  if (count > 0 && lastPlayerCount === 0) {
    console.log('[SERVER] first player connected — resetting state to Idle')
    backToIdleServerSide()
  }
  // Auto-evict any lobby member who is no longer in the scene. If they
  // were the host this disbands the lobby; otherwise they're just dropped.
  if (isIdle()) {
    const lobby = Lobby.getOrNull(LOBBY_SINGLETON)
    if (lobby) {
      const ghosts: string[] = []
      if (lobby.host !== '' && !connected.has(lobby.host)) ghosts.push(lobby.host)
      for (const p of lobby.players) {
        if (!connected.has(p) && !ghosts.includes(p)) ghosts.push(p)
      }
      for (const addr of ghosts) removeFromLobby(addr)
    }
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
  const base =
    INITIAL_GENERATION_INTERVAL_MS +
    (FINAL_GENERATION_INTERVAL_MS - INITIAL_GENERATION_INTERVAL_MS) * ramp
  // Cadence scales with the number of players locked into this round, so
  // a full lobby of 3 sees orders ~3× more often than a solo run. Floor
  // at 1 to avoid division-by-zero if the snapshot is somehow empty.
  const playerCount = Math.max(1, roundParticipants.length)
  return base / playerCount
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
  // Last-minute pressure: tickets spawned with <60 s left only live 30 s
  // instead of 45 s. The HUD reads `(expiresAt - createdAt)` to drive the
  // progress bar, so it naturally adapts to either lifetime.
  const round = RoundState.getOrNull(ROUND_SINGLETON)
  const remainingRoundMs = round ? Math.max(0, Number(round.roundEndsAt) - now) : 0
  const lifetime =
    remainingRoundMs <= FINAL_MINUTE_THRESHOLD_MS
      ? TICKET_LIFETIME_FINAL_MINUTE_MS
      : TICKET_LIFETIME_MS
  slot.expiresAt = now + lifetime
  slot.expiredSince = 0
  console.log(`[SERVER] new order: ${RECIPES[recipeIndex].displayName} (slot ${slot.slotIndex}, lifetime ${lifetime}ms)`)
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

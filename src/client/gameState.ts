import { engine } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { getPlayer } from '@dcl/sdk/players'
import { room } from '../shared/messages'
import {
  Leaderboard,
  Lobby,
  ORDER_SLOT_SYNC_IDS,
  OrderSlot,
  RoundPhase,
  RoundState,
  SyncIds
} from '../shared/syncedState'

// Read-through facade over the synced RoundState singleton. The buttons
// in the HUD send Cmd* messages and the server flips RoundState.phase;
// this module is what every consumer (HUD, optional listeners) reads.

export type GameState = 'idle' | 'playing' | 'end'

export const ROUND_DURATION_MS = 4 * 60 * 1000

let cachedPhase: RoundPhase = RoundPhase.Idle

function phaseToState(phase: RoundPhase): GameState {
  if (phase === RoundPhase.Playing) return 'playing'
  if (phase === RoundPhase.End) return 'end'
  return 'idle'
}

function findRoundEntity() {
  for (const [entity] of engine.getEntitiesWith(RoundState)) {
    return entity
  }
  return null
}

export function getRoundState() {
  const e = findRoundEntity()
  if (e === null) return null
  return RoundState.getOrNull(e)
}

export function getGameState(): GameState {
  return phaseToState(getRoundState()?.phase ?? RoundPhase.Idle)
}

export function isPlaying(): boolean {
  return (getRoundState()?.phase ?? RoundPhase.Idle) === RoundPhase.Playing
}

export function getRoundRemainingMs(): number {
  const r = getRoundState()
  if (!r || r.phase !== RoundPhase.Playing) return 0
  return Math.max(0, Number(r.roundEndsAt) - Date.now())
}

export type LeaderboardEntry = { name: string; score: number }

export function getLeaderboardEntries(): readonly LeaderboardEntry[] {
  for (const [entity] of engine.getEntitiesWith(Leaderboard)) {
    return Leaderboard.getOrNull(entity)?.entries ?? []
  }
  return []
}

// Production network round-trips for any Cmd* take 1-3 s, so the UI needs
// to give the player immediate feedback while the synced state catches up.
// Every lobby action stamps a timestamp here; the matching `isXPending()`
// returns true until either the synced state confirms the change or the
// PENDING_TIMEOUT_MS elapses (so we recover from a dropped RPC).
const PENDING_TIMEOUT_MS = 10_000
let pendingCreateAt = 0
let pendingJoinAt = 0
let pendingStartAt = 0
let pendingLeaveAt = 0

function clearIfExpired(stampedAt: number): number {
  if (stampedAt === 0) return 0
  if (Date.now() - stampedAt > PENDING_TIMEOUT_MS) return 0
  return stampedAt
}

export function startRound(): void {
  console.log('[CLIENT] CmdStartRound sent')
  pendingStartAt = Date.now()
  room.send('CmdStartRound', {})
}

export function endRound(): void {
  console.log('[CLIENT] CmdQuitRound sent')
  room.send('CmdQuitRound', {})
}

export function backToIdle(): void {
  console.log('[CLIENT] CmdBackToIdle sent')
  room.send('CmdBackToIdle', {})
}

export function isCreatePending(): boolean {
  pendingCreateAt = clearIfExpired(pendingCreateAt)
  if (pendingCreateAt === 0) return false
  // Confirmed: any lobby host means the create landed.
  if (getLobby().host !== '') {
    pendingCreateAt = 0
    return false
  }
  return true
}

export function isJoinPending(): boolean {
  pendingJoinAt = clearIfExpired(pendingJoinAt)
  if (pendingJoinAt === 0) return false
  // Confirmed: local address shows up in the lobby's player list.
  if (isLocalInLobby()) {
    pendingJoinAt = 0
    return false
  }
  return true
}

export function isStartPending(): boolean {
  pendingStartAt = clearIfExpired(pendingStartAt)
  if (pendingStartAt === 0) return false
  // Confirmed: round phase flipped to Playing.
  if (isPlaying()) {
    pendingStartAt = 0
    return false
  }
  return true
}

export function isLeavePending(): boolean {
  pendingLeaveAt = clearIfExpired(pendingLeaveAt)
  if (pendingLeaveAt === 0) return false
  // Confirmed: the local player is no longer in any lobby (either we
  // left, or the host disbanded and the whole lobby was wiped).
  if (!isLocalInLobby() && !isLocalHost()) {
    pendingLeaveAt = 0
    return false
  }
  return true
}

// ------------------------------------------------------------------------
// Lobby — synced state + the four Cmd helpers
// ------------------------------------------------------------------------

export type LobbyView = {
  host: string
  players: readonly string[]
}

export function getLobby(): LobbyView {
  for (const [entity] of engine.getEntitiesWith(Lobby)) {
    const lb = Lobby.getOrNull(entity)
    if (lb) return { host: lb.host, players: lb.players }
  }
  return { host: '', players: [] }
}

// Local-player address. getPlayer() with no args returns the local
// avatar in the explorer; on cold load it can briefly be null until
// the profile propagates, so we tolerate that.
export function getLocalAddress(): string | null {
  const player = getPlayer()
  return player?.userId ?? null
}

export function isLocalHost(): boolean {
  const me = getLocalAddress()
  if (!me) return false
  return getLobby().host === me
}

export function isLocalInLobby(): boolean {
  const me = getLocalAddress()
  if (!me) return false
  return getLobby().players.includes(me)
}

export function createGame(): void {
  console.log('[CLIENT] CmdCreateGame sent')
  pendingCreateAt = Date.now()
  room.send('CmdCreateGame', {})
}

export function joinLobby(): void {
  console.log('[CLIENT] CmdJoinLobby sent')
  pendingJoinAt = Date.now()
  room.send('CmdJoinLobby', {})
}

export function leaveLobby(): void {
  console.log('[CLIENT] CmdLeaveLobby sent')
  pendingLeaveAt = Date.now()
  room.send('CmdLeaveLobby', {})
}

// Watcher logs phase transitions so we can confirm sync round-trips during
// development. No side-effects beyond the log — the kitchen lifecycle on
// the server handles all the actual reset/spawn work.
function phaseWatcherSystem(_dt: number) {
  if (isServer()) return
  const r = getRoundState()
  if (!r) return
  if (r.phase !== cachedPhase) {
    const prev = cachedPhase
    cachedPhase = r.phase as RoundPhase
    if (cachedPhase === RoundPhase.Playing && prev !== RoundPhase.Playing) {
      console.log('[CLIENT] round started')
    } else if (cachedPhase === RoundPhase.End && prev === RoundPhase.Playing) {
      console.log('[CLIENT] round ended')
    } else if (cachedPhase === RoundPhase.Idle && prev !== RoundPhase.Idle) {
      console.log('[CLIENT] back to idle')
    }
  }
}

engine.addSystem(phaseWatcherSystem)

// Touch unused imports so esbuild can't tree-shake the synced order-slot
// IDs away — late-joining clients need them materialized.
void ORDER_SLOT_SYNC_IDS
void SyncIds
void OrderSlot

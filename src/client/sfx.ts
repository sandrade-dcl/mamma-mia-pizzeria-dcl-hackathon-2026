import { AudioSource, Entity, Transform, engine } from '@dcl/sdk/ecs'
import { RoundPhase } from '../shared/syncedState'
import { getRoundState } from './gameState'

// One-shot SFX tied to score changes. The authoritative score lives in
// RoundState on the server; every client watches the synced value and
// plays the matching clip locally when the delta changes sign.
//
// AudioSource only retriggers when `playing` flips false→true, so we
// queue a "set to true next frame" after forcing false. Two entities so
// the gain/lose clips don't cut each other off.

const SFX_DELIVERED_URL = 'assets/Audio/pizza_delivered.mp3'
const SFX_LOST_URL = 'assets/Audio/pizza_lost.mp3'
const SFX_VOLUME = 1

let sfxDelivered: Entity = 0 as Entity
let sfxLost: Entity = 0 as Entity

let lastScore = 0
let lastPhase: RoundPhase = RoundPhase.Idle
let pendingDelivered = false
let pendingLost = false

export function setupScoreSfx() {
  sfxDelivered = createSfxEntity(SFX_DELIVERED_URL)
  sfxLost = createSfxEntity(SFX_LOST_URL)
  engine.addSystem(scoreSfxSystem)
}

function createSfxEntity(url: string): Entity {
  const e = engine.addEntity()
  Transform.create(e, { position: { x: 0, y: 0, z: 0 } })
  AudioSource.create(e, {
    audioClipUrl: url,
    playing: false,
    volume: SFX_VOLUME,
    loop: false,
    global: true
  })
  return e
}

function trigger(entity: Entity, flag: 'delivered' | 'lost') {
  AudioSource.getMutable(entity).playing = false
  if (flag === 'delivered') pendingDelivered = true
  else pendingLost = true
}

function scoreSfxSystem(_dt: number) {
  if (pendingDelivered) {
    AudioSource.getMutable(sfxDelivered).playing = true
    pendingDelivered = false
  }
  if (pendingLost) {
    AudioSource.getMutable(sfxLost).playing = true
    pendingLost = false
  }

  const round = getRoundState()
  if (!round) return

  const phase = round.phase as RoundPhase
  if (phase !== lastPhase) {
    if (phase === RoundPhase.Playing) lastScore = round.score
    lastPhase = phase
  }

  if (phase !== RoundPhase.Playing) return

  const score = round.score
  if (score === lastScore) return
  if (score > lastScore) trigger(sfxDelivered, 'delivered')
  else trigger(sfxLost, 'lost')
  lastScore = score
}

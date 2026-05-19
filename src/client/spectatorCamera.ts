import { Entity, MainCamera, Transform, VirtualCamera, engine } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { isLocalInLobby, isPlaying } from './gameState'

// Spectator camera — a single VirtualCamera entity parked above the
// kitchen looking down. While active, the local explorer's MainCamera
// points to it instead of the avatar, so the player gets a top-down
// view of the round without losing access to the scene UI. The avatar
// stays where it was; exiting the mode returns control instantly.
//
// The camera lives in client-only state (not synced) because each player
// chooses independently whether to spectate. A short auto-exit system
// kicks in when the round ends or when the player rejoins the lobby, so
// the explorer never gets stuck on the elevated camera.

let cameraEntity: Entity | null = null
let lookAtEntity: Entity | null = null
let active = false

const CAMERA_POSITION = Vector3.create(16, 20, 4)
const LOOK_AT_POSITION = Vector3.create(16, 1, 20)
const TRANSITION_SECONDS = 0.6

export function setupSpectatorCamera() {
  if (cameraEntity !== null) return

  lookAtEntity = engine.addEntity()
  Transform.create(lookAtEntity, { position: LOOK_AT_POSITION })

  cameraEntity = engine.addEntity()
  Transform.create(cameraEntity, { position: CAMERA_POSITION })
  VirtualCamera.create(cameraEntity, {
    defaultTransition: { transitionMode: { $case: 'time', time: TRANSITION_SECONDS } },
    lookAtEntity
  })

  engine.addSystem(spectatorGateSystem)
}

export function isSpectatorCameraActive(): boolean {
  return active
}

export function enterSpectatorMode() {
  if (cameraEntity === null) return
  if (active) return
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: cameraEntity })
  active = true
  console.log('[CLIENT] entered spectator camera')
}

export function exitSpectatorMode() {
  if (!active) return
  MainCamera.deleteFrom(engine.CameraEntity)
  active = false
  console.log('[CLIENT] exited spectator camera')
}

// Auto-exit guard: the spectator camera only makes sense while a round is
// in progress and the local player is NOT part of it. The moment either
// condition flips we release the camera so the player isn't stranded on
// the rooftop view.
function spectatorGateSystem(_dt: number) {
  if (!active) return
  if (!isPlaying() || isLocalInLobby()) {
    exitSpectatorMode()
  }
}

import {
  AvatarModifierArea,
  AvatarModifierType,
  Entity,
  Transform,
  engine
} from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { getLobby, isPlaying } from './gameState'

// Hides every avatar inside the scene that isn't part of the active
// round. We use one local AvatarModifierArea covering the full 32×32m
// floor with a generous vertical extent so the spectator camera up
// above still sits within the volume. Lobby members are listed in
// `excludeIds` so they remain visible; everyone else (other spectators)
// is hidden for the duration of Playing. The component is created once
// and toggled by signature so we only mutate the data when the lobby
// composition or round phase actually changes.

let areaEntity: Entity | null = null
let lastSignature = ''

const AREA_CENTER = Vector3.create(16, 16, 16)
const AREA_SIZE = Vector3.create(40, 50, 40)

export function setupAvatarVisibility() {
  if (areaEntity !== null) return
  areaEntity = engine.addEntity()
  Transform.create(areaEntity, { position: AREA_CENTER })
  AvatarModifierArea.create(areaEntity, {
    area: AREA_SIZE,
    excludeIds: [],
    modifiers: []
  })
  engine.addSystem(visibilitySystem)
}

function visibilitySystem(_dt: number) {
  if (areaEntity === null) return
  const playing = isPlaying()
  const lobby = getLobby()
  // Sort the IDs so the signature is stable regardless of mutation
  // order in the synced Lobby.players array.
  const excludeIds = playing ? lobby.players.slice().sort() : []
  const signature = `${playing ? 1 : 0}|${excludeIds.join(',')}`
  if (signature === lastSignature) return
  lastSignature = signature
  const a = AvatarModifierArea.getMutable(areaEntity)
  a.excludeIds = excludeIds
  a.modifiers = playing ? [AvatarModifierType.AMT_HIDE_AVATARS] : []
}

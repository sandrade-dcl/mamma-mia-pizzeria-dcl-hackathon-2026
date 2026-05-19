import { TextShape, engine } from '@dcl/sdk/ecs'
import { EntityNames } from '../../assets/scene/entity-names'
import { LEADERBOARD_MAX, Leaderboard } from '../shared/syncedState'

// 3D scoreboard rendered entirely from the composite — the
// `Anchor_Leaderboard` parent holds the `Leaderboard_Backboard` (PBR box)
// and `Leaderboard_Text` (TextShape) children. Move/rotate/scale any of
// those in the Creator Hub editor to reposition the panel without
// touching code. This module just rewrites the TextShape's `text` field
// every frame from the synced Leaderboard component so all players see
// the same standings.

export function setupLeaderboardWall() {
  const textEntity = engine.getEntityOrNullByName(EntityNames.Leaderboard_Text)
  if (!textEntity) {
    console.log('[CLIENT] Leaderboard_Text not found in composite — leaderboard wall skipped')
    return
  }
  engine.addSystem(leaderboardWallSystem)
}

function initialText(): string {
  return `Top ${LEADERBOARD_MAX} Scoreboard\n\nNo scores yet — be the first!`
}

function leaderboardWallSystem(_dt: number) {
  const textEntity = engine.getEntityOrNullByName(EntityNames.Leaderboard_Text)
  if (!textEntity) return
  const ts = TextShape.getMutableOrNull(textEntity)
  if (!ts) return
  for (const [entity] of engine.getEntitiesWith(Leaderboard)) {
    const lb = Leaderboard.getOrNull(entity)
    if (!lb) continue
    if (!lb.entries || lb.entries.length === 0) {
      ts.text = initialText()
      return
    }
    const header = `Top ${LEADERBOARD_MAX} Scoreboard`
    const rows = lb.entries
      .slice(0, LEADERBOARD_MAX)
      .map((entry, i) => `${(i + 1).toString().padStart(2, ' ')}. ${entry.name}  —  ${entry.score}`)
    ts.text = [header, '', ...rows].join('\n')
    return
  }
}

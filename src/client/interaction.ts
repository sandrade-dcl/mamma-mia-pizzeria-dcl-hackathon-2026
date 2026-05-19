import {
  Entity,
  InputAction,
  PointerEventType,
  PointerEvents,
  engine,
  inputSystem
} from '@dcl/sdk/ecs'
import { isLocalInLobby, isPlaying } from './gameState'

// Click handler that fires on the left mouse button (IA_POINTER) and,
// optionally, on the F key (IA_SECONDARY) for a contextual second action like
// "discard". The built-in `pointerEventsSystem.onPointerDown` only registers
// a single button per entity; using PointerEvents directly + an inputSystem
// dispatcher lets us bind two distinct actions per entity with their own
// hover text labels.

type PointerEventDef = {
  eventType: PointerEventType
  eventInfo: {
    button: InputAction
    hoverText?: string
    maxDistance?: number
    showFeedback: boolean
  }
}

type SecondaryAction = {
  hoverText?: string
  callback: () => void
}

type InteractionOptions = {
  hoverText?: string
  maxDistance?: number
  secondary?: SecondaryAction
}

type Entry = {
  entity: Entity
  pointerEvents: PointerEventDef[]
  primaryCallback?: () => void
  secondaryCallback?: () => void
}

const entries: Entry[] = []

// Cursor + hover feedback are only active for players who are part of the
// current round (i.e. in the lobby AND the round is in Playing). Spectators
// and everyone in Idle/End see the kitchen but cannot click on it.
function localCanInteract(): boolean {
  return isPlaying() && isLocalInLobby()
}

let lastCanInteract = false

function applyPointerEvents(entry: Entry, enabled: boolean) {
  if (enabled && entry.pointerEvents.length > 0) {
    PointerEvents.createOrReplace(entry.entity, { pointerEvents: entry.pointerEvents })
  } else {
    PointerEvents.deleteFrom(entry.entity)
  }
}

export function onInteract(
  entity: Entity,
  opts: InteractionOptions,
  primaryCallback?: () => void
) {
  const pointerEvents: PointerEventDef[] = []

  if (primaryCallback) {
    pointerEvents.push({
      eventType: PointerEventType.PET_DOWN,
      eventInfo: {
        button: InputAction.IA_POINTER,
        hoverText: opts.hoverText,
        maxDistance: opts.maxDistance,
        showFeedback: true
      }
    })
  }

  if (opts.secondary) {
    pointerEvents.push({
      eventType: PointerEventType.PET_DOWN,
      eventInfo: {
        button: InputAction.IA_SECONDARY,
        hoverText: opts.secondary.hoverText,
        maxDistance: opts.maxDistance,
        showFeedback: true
      }
    })
  }

  // Replace any previous entry for this entity so re-attaching a handler
  // (e.g. after a pizza moves to a new station) doesn't fire stale logic.
  const existingIndex = entries.findIndex((e) => e.entity === entity)
  if (existingIndex >= 0) {
    entries.splice(existingIndex, 1)
  }
  if (primaryCallback || opts.secondary) {
    const entry: Entry = {
      entity,
      pointerEvents,
      primaryCallback,
      secondaryCallback: opts.secondary?.callback
    }
    entries.push(entry)
    applyPointerEvents(entry, lastCanInteract)
  } else {
    PointerEvents.deleteFrom(entity)
  }
}

function interactionSystem(_dt: number) {
  // Re-evaluate gating once per frame; when the flag flips we add or
  // remove the PointerEvents component from every registered entity so
  // the cursor + hover label disappear for spectators in real time.
  const canInteract = localCanInteract()
  if (canInteract !== lastCanInteract) {
    lastCanInteract = canInteract
    for (const entry of entries) applyPointerEvents(entry, canInteract)
  }

  if (!canInteract || entries.length === 0) return
  // Snapshot the list before iterating: callbacks may re-attach a handler
  // (which splices the old entry out and pushes a new one), and we must NOT
  // let the iterator pick up the just-pushed entry on the same frame — that
  // would dispatch the same click twice. Snapshot guarantees one callback
  // per entity per frame.
  const snapshot = entries.slice()
  for (const entry of snapshot) {
    if (
      entry.primaryCallback &&
      inputSystem.isTriggered(InputAction.IA_POINTER, PointerEventType.PET_DOWN, entry.entity)
    ) {
      entry.primaryCallback()
    }
    if (
      entry.secondaryCallback &&
      inputSystem.isTriggered(InputAction.IA_SECONDARY, PointerEventType.PET_DOWN, entry.entity)
    ) {
      entry.secondaryCallback()
    }
  }
}

engine.addSystem(interactionSystem)

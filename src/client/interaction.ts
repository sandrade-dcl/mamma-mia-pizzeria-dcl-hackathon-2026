import {
  Entity,
  InputAction,
  PointerEventType,
  PointerEvents,
  engine,
  inputSystem
} from '@dcl/sdk/ecs'

// Click handler that fires on the left mouse button (IA_POINTER) and,
// optionally, on the F key (IA_SECONDARY) for a contextual second action like
// "discard". The built-in `pointerEventsSystem.onPointerDown` only registers
// a single button per entity; using PointerEvents directly + an inputSystem
// dispatcher lets us bind two distinct actions per entity with their own
// hover text labels.

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
  primaryCallback?: () => void
  secondaryCallback?: () => void
}

const entries: Entry[] = []

export function onInteract(
  entity: Entity,
  opts: InteractionOptions,
  primaryCallback?: () => void
) {
  const pointerEvents: {
    eventType: PointerEventType
    eventInfo: {
      button: InputAction
      hoverText?: string
      maxDistance?: number
      showFeedback: boolean
    }
  }[] = []

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

  if (pointerEvents.length === 0) {
    PointerEvents.deleteFrom(entity)
  } else {
    PointerEvents.createOrReplace(entity, { pointerEvents })
  }

  // Replace any previous entry for this entity so re-attaching a handler
  // (e.g. after a pizza moves to a new station) doesn't fire stale logic.
  const existingIndex = entries.findIndex((e) => e.entity === entity)
  if (existingIndex >= 0) {
    entries.splice(existingIndex, 1)
  }
  if (primaryCallback || opts.secondary) {
    entries.push({
      entity,
      primaryCallback,
      secondaryCallback: opts.secondary?.callback
    })
  }
}

function interactionSystem(_dt: number) {
  for (const entry of entries) {
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

import { isServer } from '@dcl/sdk/network'
import { initClient } from './client/setup'
import { initServer } from './server/server'

export function main() {
  if (isServer()) {
    initServer()
  } else {
    initClient()
  }
}

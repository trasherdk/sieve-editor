import type { SieveApi } from '../shared/types'

declare global {
  interface Window {
    api: SieveApi
  }
}

export {}

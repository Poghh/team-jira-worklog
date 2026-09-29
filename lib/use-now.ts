import { useSyncExternalStore } from 'react'

/**
 * The current time in epoch seconds, rounded to `stepSeconds` and refreshed
 * that often — or `null` while rendering on the server and during hydration.
 *
 * "3 phút trước" computed during render is a hydration mismatch waiting to
 * happen: the server renders at one instant, the browser hydrates at another,
 * and near a boundary the two strings differ. Returning null until the client
 * has taken over lets relative times render as nothing first, then fill in.
 */
const stores = new Map<number, { subscribe: (cb: () => void) => () => void; get: () => number }>()

function store(step: number) {
  let s = stores.get(step)
  if (!s) {
    s = {
      subscribe: (cb) => {
        const t = setInterval(cb, step * 1000)
        return () => clearInterval(t)
      },
      // Stable between calls within a step, as useSyncExternalStore requires.
      get: () => Math.floor(Date.now() / 1000 / step) * step,
    }
    stores.set(step, s)
  }
  return s
}

const serverSnapshot = () => null

export function useNow(stepSeconds = 30): number | null {
  const s = store(stepSeconds)
  return useSyncExternalStore(s.subscribe, s.get, serverSnapshot)
}

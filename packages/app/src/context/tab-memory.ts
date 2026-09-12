import { createRoot, type Owner } from "solid-js"

type Entry = {
  value: unknown
  dispose: VoidFunction
}

export function createTabMemory(owner: Owner | null) {
  const entries = new Map<string, Map<string, Entry>>()

  const remove = (key: string) => {
    const state = entries.get(key)
    if (!state) return
    for (const entry of state.values()) entry.dispose()
    entries.delete(key)
  }

  return {
    get<T>(key: string, name: string) {
      return entries.get(key)?.get(name)?.value as T | undefined
    },
    ensure<T>(key: string, name: string, init: () => T) {
      const state = entries.get(key) ?? new Map<string, Entry>()
      if (!entries.has(key)) entries.set(key, state)
      const existing = state.get(name)
      if (existing) return existing.value as T
      const entry = createRoot((dispose) => ({ value: init(), dispose }), owner)
      state.set(name, entry)
      return entry.value
    },
    move(from: string, to: string) {
      if (from === to) return
      const source = entries.get(from)
      if (!source) return
      const target = entries.get(to)
      if (!target) {
        entries.set(to, source)
        entries.delete(from)
        return
      }
      for (const [name, entry] of source) {
        if (!target.has(name)) {
          target.set(name, entry)
          continue
        }
        entry.dispose()
      }
      entries.delete(from)
    },
    remove,
    dispose() {
      for (const key of entries.keys()) remove(key)
    },
  }
}

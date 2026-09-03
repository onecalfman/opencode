export function groupTabsByServer<T extends { server: string }>(tabs: T[]) {
  const groups = new Map<T["server"], T[]>()
  tabs.forEach((tab) => {
    const group = groups.get(tab.server)
    if (group) {
      group.push(tab)
      return
    }
    groups.set(tab.server, [tab])
  })
  return [...groups].map(([server, items]) => ({ server, tabs: items }))
}

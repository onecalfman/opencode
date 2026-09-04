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

export function groupTabsByServerAndProject<T extends { server: string }>(
  tabs: T[],
  projectKey: (tab: T) => string,
) {
  return groupTabsByServer(tabs).map((server) => {
    const projects = new Map<string, T[]>()
    server.tabs.forEach((tab) => {
      const key = projectKey(tab)
      const group = projects.get(key)
      if (group) {
        group.push(tab)
        return
      }
      projects.set(key, [tab])
    })
    return {
      server: server.server,
      projects: [...projects].map(([project, items]) => ({ project, tabs: items })),
    }
  })
}

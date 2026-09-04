export function groupTabsByServerAndProject<T extends { server: string }>(tabs: T[], projectKey: (tab: T) => string) {
  const groups = new Map<string, Map<string, T[]>>()
  tabs.forEach((tab) => {
    const projects = groups.get(tab.server) ?? new Map<string, T[]>()
    const key = projectKey(tab)
    projects.set(key, [...(projects.get(key) ?? []), tab])
    groups.set(tab.server, projects)
  })
  return [...groups].map(([server, projects]) => ({
    server,
    projects: [...projects].map(([project, items]) => ({ project, tabs: items })),
  }))
}

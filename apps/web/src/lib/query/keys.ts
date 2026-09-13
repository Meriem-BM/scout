export const queryKeys = {
  snapshot: (userId: string | null) => ["snapshot", userId] as const,
  watches: ["watches"] as const,
  watch: (id: string | null) => ["watches", "detail", id] as const,
  collection: (filter: string, sort: string, search: string, page: number) =>
    ["watches", "list", { filter, sort, search, page }] as const,
  history: (id: string, search: string, filter: string, page: number) =>
    ["watches", "history", id, { search, filter, page }] as const,
  workflow: (id: string) => ["workflow", id] as const,
  incident: (id: string | null) => ["incident", id] as const,
  incidents: ["incident"] as const,
  proof: (id: string) => ["proof", id] as const,
  connections: ["connections"] as const,
  trades: ["trades"] as const,
};

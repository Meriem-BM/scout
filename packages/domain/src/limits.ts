export const LIMITS = {
  activeWatches: 5,
  conditions: 3,
  windowSeconds: 3600,
  previewSwaps: 250,
  previewHours: 24,
  eventsPerWindow: 5000,
  evidencePerIncident: 200,
  freshnessSeconds: 180,
  incidentCooldownSeconds: 900,
} as const;

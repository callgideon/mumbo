// Shared running-sandbox cap for boxes (edge.mjs) and children (sandboxes.mjs).
/** Capacity units per running sandbox, by memory: person and project boxes are 4096 MB (template.mjs default), children 2048 MB (the
 *  `mumbo-child` build argument). A child is any sandbox with `metadata.owner`. MAX_RUNNING_UNITS caps the sum over running sandboxes. */
export const UNITS = { box: 2, child: 1 }

/** The capacity units in use: every running sandbox, a box at UNITS.box and a child at UNITS.child. */
export async function runningUnits(e2b) {
  const pager = e2b.Sandbox.list({ query: { state: ['running'] } })
  let units = 0
  while (pager.hasNext) for (const s of await pager.nextItems()) units += s.metadata?.owner ? UNITS.child : UNITS.box
  return units
}

/** True when adding a sandbox of `weight` units would pass cfg.maxRunningUnits (0: no edge-side cap). */
export async function atCapacity(e2b, cfg, weight) {
  return cfg.maxRunningUnits > 0 && (await runningUnits(e2b)) + weight > cfg.maxRunningUnits
}

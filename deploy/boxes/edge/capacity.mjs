// Shared running-sandbox cap for boxes (edge.mjs) and children (sandboxes.mjs), per cell (cells.mjs): each cell has its
// own E2B API and team key, so a count covers exactly one cell, against that cell's maxUnits. The cap is approximate: the count and the create are
// not atomic, so concurrent creates can pass the limit together; the two boxes of headroom in MAX_RUNNING_UNITS absorb that.
/** Capacity units per running sandbox, by memory (one unit is 2048 MB of node hugepages): person boxes are 4096 MB (template.mjs
 *  default), project boxes 8192 MB (the mumbo-project build), children 2048 MB (the `mumbo-child` build argument). A child is any
 *  sandbox with `metadata.owner`; a project box has `metadata.user` `project:<id>`. MAX_RUNNING_UNITS caps the sum over running
 *  sandboxes. */
export const UNITS = { box: 2, project: 4, child: 1 }

/** The units of a sandbox with this `metadata`: a child, a project box, or any other box. */
export const unitsFor = (metadata) => metadata?.owner ? UNITS.child : String(metadata?.user ?? '').startsWith('project:') ? UNITS.project : UNITS.box

/** The capacity units in use: the sum of unitsFor over every running sandbox `Sandbox` (one cell's E2B class) lists. */
export async function runningUnits(Sandbox) {
  const pager = Sandbox.list({ query: { state: ['running'] } })
  let units = 0
  while (pager.hasNext) for (const s of await pager.nextItems()) units += unitsFor(s.metadata)
  return units
}

/** True when adding a sandbox of `weight` units to `cell` would pass its maxUnits (0: no edge-side cap). */
export async function atCapacity(cell, weight) {
  return cell.maxUnits > 0 && (await runningUnits(cell.Sandbox)) + weight > cell.maxUnits
}

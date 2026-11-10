/**
 * Canonical publication manifest for the documentation website.
 *
 * Markdown stays in its owning repository tier. This manifest maps each
 * canonical source into the site's route tree without copying Markdown.
 */

/** Sidebar collection rendered for one top-level module. */
export type DocsSidebar = 'guide' | 'develop' | 'reference'

/** A page projected into the VitePress source tree. */
export interface DocsPage {
  /** Repository-relative canonical Markdown source. */
  source: string
  /** VitePress route, including the `.md` suffix. */
  route: string
  /** Navigation label shown in the sidebar. */
  label: string
  /** Sidebar collection that owns the page, or null for the home page. */
  sidebar: DocsSidebar | null
  /** Section label within the sidebar. */
  section: string
  /** Stable order within the section. */
  order: number
  /** Heading levels included in this page's VitePress outline. */
  outline?: number | readonly [number, number] | 'deep' | false
  /** Additional repository paths that resolve to this page. */
  sourceAliases?: string[]
}

const homeAndGuide: DocsPage[] = [
  {
    source: 'docs/user/index.md',
    route: 'index.md',
    label: 'DeepSeek Harness',
    sidebar: null,
    section: 'Home',
    order: 0,
  },
  ...([
    ['docs/user/guide/index.md', 'guide/quickstart.md', 'Use the Web UI', 'Guide', 1],
    ['docs/user/guide/providers.md', 'guide/providers.md', 'Configure models', 'Guide', 2],
    ['docs/user/guide/network-proxy.md', 'guide/network-proxy.md', 'Network proxy', 'Guide', 3],
    ['docs/user/guide/public-deployments.md', 'guide/public-deployments.md', 'Public deployments', 'Guide', 4],
    ['docs/user/guide/python-sdk.md', 'guide/python-sdk.md', 'Python', 'SDK', 1],
    ['docs/user/guide/github-review.md', 'guide/github-review.md', 'GitHub review sessions', 'Automation', 1],
    ['docs/user/guide/schedule.md', 'guide/schedule.md', 'Session reminders', 'Automation', 2],
    ['docs/user/guide/plugin-market.md', 'guide/plugin-market.md', 'Plugin indexes', 'Integrations', 2],
    ['docs/user/guide/mcp-memory.md', 'guide/mcp-memory.md', 'Memory MCP', 'Integrations', 1],
  ] as const).map(([source, route, label, section, order]): DocsPage => ({
    source,
    route,
    label,
    sidebar: 'guide',
    section,
    order,
    ...(source === 'docs/user/guide/index.md' ? { sourceAliases: ['docs/user/guide'] } : {}),
  })),
]

const develop: DocsPage[] = ([
  ['basic/index.md', 'Your first Harness plugin', 'Basics', 1],
  ['basic/tool.md', 'Build a tool', 'Basics', 2],
  ['basic/config.md', 'Plugin configuration', 'Basics', 3],
  ['basic/publish.md', 'Package and install', 'Basics', 4],
  ['framework/index.md', 'Plugin lifecycle', 'Framework', 1],
  ['framework/service.md', 'Services and dependencies', 'Framework', 2],
  ['framework/events.md', 'Event system', 'Framework', 3],
  ['practice/index.md', 'Capability layering', 'Practice', 1],
  ['practice/llm-adapter.md', 'LLM adapter', 'Practice', 2],
  ['practice/dynamic-cordis.md', 'Persistent Harness plugins', 'Practice', 3],
] as const).map(([file, label, section, order]): DocsPage => ({
  source: `docs/user/develop/${file}`,
  route: `develop/${file}`,
  label,
  sidebar: 'develop',
  section,
  order,
  ...(file.endsWith('/index.md') ? { sourceAliases: [`docs/user/develop/${file.slice(0, -'/index.md'.length)}`] } : {}),
}))

const cordisTutorial: DocsPage[] = ([
  ['index.md', 'Overview'],
  ['01-first-plugin.md', '1. Your first plugin'],
  ['02-lifecycle-and-effects.md', '2. Lifecycle and effects'],
  ['03-services.md', '3. Services'],
  ['04-events.md', '4. Events'],
  ['05-config.md', '5. Configuration'],
  ['06-composition-and-hmr.md', '6. Composition and HMR'],
  ['07-into-the-harness.md', '7. Into the harness'],
] as const).map(([file, label], order): DocsPage => ({
  source: `docs/cordis-tutorial/${file}`,
  route: `develop/cordis-tutorial/${file}`,
  label,
  sidebar: 'develop',
  section: 'Cordis framework tutorial',
  order,
  ...(file === 'index.md' ? { sourceAliases: ['docs/cordis-tutorial'] } : {}),
}))

/**
 * Subsystem pages grouped by the concern they document, as `[section, pages]`.
 * One flat list of every subsystem pushed the rest of the reference sidebar
 * below the fold.
 */
const subsystemGroups = [
  ['Overview', [
    ['README.md', 'Subsystems'],
  ]],
  ['Core and scopes', [
    ['core.md', 'Core'],
    ['scope.md', 'Scopes'],
  ]],
  ['Sessions and persistence', [
    ['session.md', 'Sessions'],
    ['session-query.md', 'Session query'],
    ['session-reference.md', 'Session references'],
    ['session-title.md', 'Session titles'],
    ['session-projection.md', 'Session projections'],
    ['persistence.md', 'Session persistence'],
    ['spill.md', 'Spill storage'],
    ['session-telemetry.md', 'SessionTelemetryBackend'],
  ]],
  ['Model and context', [
    ['llm-streaming.md', 'LLM streaming'],
    ['token-meter.md', 'Token metering'],
    ['system-prompt.md', 'System prompts'],
    ['compaction.md', 'Compaction'],
  ]],
  ['Execution and tools', [
    ['tools.md', 'Tools'],
    ['shell.md', 'Bash execution'],
    ['subprocess.md', 'Subprocesses'],
    ['terminal.md', 'PTY sessions'],
    ['jobs.md', 'Background jobs'],
    ['filesystem.md', 'Filesystem'],
    ['lsp.md', 'LSP navigation'],
    ['ptc-runtime.md', 'PTC runtime'],
    ['web.md', 'Web access'],
    ['skills.md', 'Skills'],
    ['workflow.md', 'Workflows'],
    ['subagent.md', 'Subagents'],
  ]],
  ['Policy and interaction', [
    ['approval.md', 'Approvals'],
    ['permission-presets.md', 'Permission presets'],
    ['sandbox.md', 'Sandboxing'],
    ['plan.md', 'Plan mode'],
    ['user-questions.md', 'User interaction'],
    ['commands.md', 'Human commands'],
    ['goal.md', 'Goals'],
    ['schedule.md', 'Scheduled reminders'],
  ]],
  ['Platform and access', [
    ['web-server.md', 'HTTP server'],
    ['web-client.md', 'Web Client architecture'],
    ['client-modules.md', 'Client modules'],
    ['slots.md', 'Client slots'],
    ['client-resources.md', 'Client resources'],
    ['sidebar-right.md', 'Right Sidebar'],
    ['conversation.md', 'Conversation assembly'],
    ['typert.md', 'Typert'],
    ['storage.md', 'Storage'],
    ['workspace.md', 'Workspaces'],
    ['settings.md', 'User settings'],
    ['credentials.md', 'User credentials'],
  ]],
] as const

const cordisPrimerReference: DocsPage = {
  source: 'docs/cordis-primer.md',
  route: 'reference/cordis-primer.md',
  label: 'Cordis primer',
  sidebar: 'reference',
  section: 'Concepts',
  order: 1,
}

const subsystemsReference: DocsPage[] = subsystemGroups.flatMap(([section, files]) => files.map(([file, label], order): DocsPage => ({
  source: `docs/subsystems/${file}`,
  route: file === 'README.md' ? 'reference/subsystems/index.md' : `reference/subsystems/${file}`,
  label,
  sidebar: 'reference',
  section,
  order,
  // Subsystem pages carry long third-level sections a two-level outline reaches.
  outline: [2, 3],
  ...(file === 'README.md' ? { sourceAliases: ['docs/subsystems'] } : {}),
})))

/** Reference pages outside the subsystem groups, as `[source, route, label, section, order, outline?]`. */
const referencePages = [
  // `docs/deepseek-llm-api-wire-extensions.md` is a repository-only provider protocol reference.
  // Projected links intentionally resolve to its GitHub source instead of a public site route.
  ['docs/architecture.md', 'reference/index.md', 'Architecture', 'Concepts', 0],
  ['docs/capability-seams.md', 'reference/capability-seams.md', 'Capability services', 'Concepts', 2],
  ['docs/agent-lifecycle.md', 'reference/agent-lifecycle.md', 'Agent lifecycle', 'Concepts', 3],
  ['docs/tool-execution-pipeline.md', 'reference/tool-execution-pipeline.md', 'Tool execution', 'Concepts', 4],
  ['docs/api-gateway.md', 'reference/api-gateway.md', 'API Gateway', 'Concepts', 5],
  ['docs/config-catalog.md', 'reference/config-catalog.md', 'Plugin configuration', 'Generated reference', 0],
  ['docs/tool-catalog.md', 'reference/tool-catalog.md', 'Tool schemas', 'Generated reference', 1],
  ['docs/persistence-catalog.md', 'reference/persistence-catalog.md', 'Persistence events', 'Generated reference', 2, 'deep'],
  ['docs/experimental-persistence-catalog.md', 'reference/experimental-persistence-catalog.md', 'Experimental persistence', 'Generated reference', 3],
  ['docs/cordis-api/context.md', 'reference/cordis-api/context.md', 'Context', 'Cordis Core API', 0],
  ['docs/cordis-api/events.md', 'reference/cordis-api/events.md', 'Events', 'Cordis Core API', 1],
  ['docs/cordis-api/fiber.md', 'reference/cordis-api/fiber.md', 'Fiber', 'Cordis Core API', 2],
  ['docs/cordis-api/registry.md', 'reference/cordis-api/registry.md', 'Plugin Registry', 'Cordis Core API', 3],
  ['docs/cordis-api/service.md', 'reference/cordis-api/service.md', 'Service', 'Cordis Core API', 4],
  ['docs/cordis-api/inherited.md', 'reference/cordis-api/inherited.md', 'Inherited surface', 'Cordis Core API', 5],
  ['docs/cookbook/adding-a-package.md', 'reference/cookbook/adding-a-package.md', 'Adding a package', 'Cookbook', 0],
  ['docs/cookbook/adding-a-tool.md', 'reference/cookbook/adding-a-tool.md', 'Adding a tool', 'Cookbook', 1],
  ['docs/cookbook/adding-an-llm-adapter.md', 'reference/cookbook/adding-an-llm-adapter.md', 'Adding an LLM adapter', 'Cookbook', 2],
  ['docs/cookbook/adding-a-settings-card.md', 'reference/cookbook/adding-a-settings-card.md', 'Adding a settings page', 'Cookbook', 3],
  ['docs/cookbook/extension-cookbook.md', 'reference/cookbook/extension-cookbook.md', 'Extension patterns', 'Cookbook', 4],
] as const

const reference: DocsPage[] = referencePages.map(([source, route, label, section, order, outline]): DocsPage => ({
  source,
  route,
  label,
  sidebar: 'reference',
  section,
  order,
  ...(outline === undefined ? {} : { outline }),
}))

/**
 * Sidebar collections in the order the site's navigation presents them. The
 * navigation bar and the llms.txt index both read this sequence, so a new
 * collection lands in both surfaces together.
 */
export const docsCollections = ['guide', 'develop', 'reference'] as const satisfies readonly DocsSidebar[]

/** A sidebar group, matched to pages by `label`. */
export interface DocsSection {
  /** Group heading, equal to the `section` field of every page it holds. */
  label: string
  /** Render the group collapsed until it holds the page being read. */
  collapsed?: boolean
}

/**
 * Every sidebar group, in render order.
 *
 * The subsystem groups collapse because together they outnumber the rest of the
 * reference sidebar; expanded, they push every other group below the fold.
 */
const sections: readonly DocsSection[] = [
  { label: 'Guide' }, { label: 'SDK' }, { label: 'Automation' }, { label: 'Integrations' },
  { label: 'Basics' }, { label: 'Framework' }, { label: 'Practice' }, { label: 'Cordis framework tutorial' },
  { label: 'Concepts' }, { label: 'Generated reference' }, { label: 'Cordis Core API' }, { label: 'Cookbook' },
  { label: 'Overview' },
  { label: 'Core and scopes', collapsed: true },
  { label: 'Sessions and persistence', collapsed: true },
  { label: 'Model and context', collapsed: true },
  { label: 'Execution and tools', collapsed: true },
  { label: 'Policy and interaction', collapsed: true },
  { label: 'Platform and access', collapsed: true },
]

/**
 * Placement and collapse behavior of one sidebar group.
 *
 * @param label - Section label carried by the pages in the group.
 * @returns The declared group, plus its zero-based position.
 * @throws When no placement is declared for the label. Ranking by list
 *   membership alone would sort an undeclared group silently ahead of every
 *   declared one.
 */
export function sectionSpec(label: string): DocsSection & { index: number } {
  const section = sections.find(candidate => candidate.label === label)
  if (section === undefined) throw new Error(`Sidebar section "${label}" has no placement.`)
  return { ...section, index: sections.indexOf(section) }
}

/** Every canonical page published by the documentation website. */
export const docsPages: DocsPage[] = [
  ...homeAndGuide,
  ...develop,
  ...cordisTutorial,
  cordisPrimerReference,
  ...subsystemsReference,
  ...reference,
]

/**
 * Pages of one sidebar collection, in the order the sidebar lists them.
 *
 * @param collection - Sidebar collection to read.
 * @returns The collection's pages, ordered by section placement then by `order`.
 */
export function orderedPages(collection: DocsSidebar): DocsPage[] {
  return docsPages
    .filter(page => page.sidebar === collection)
    .sort((left, right) => (
      sectionSpec(left.section).index - sectionSpec(right.section).index
      || left.order - right.order
    ))
}

/**
 * Site-relative link for a published route.
 *
 * @param route - Manifest route, including its `.md` suffix.
 * @returns The link VitePress serves the route at.
 */
export function routeLink(route: string): string {
  return `/${route.replace(/(?:index)?\.md$/, '')}`
}

/**
 * Where a top-level navigation item lands.
 *
 * The target is derived rather than written down: a collection whose first page
 * is renamed or reordered would otherwise leave the navigation bar pointing at
 * a route the manifest no longer publishes.
 *
 * @param collection - Sidebar collection the item opens.
 * @returns Site-relative link of the collection's first page.
 * @throws When the collection publishes no page.
 */
export function landingLink(collection: DocsSidebar): string {
  const first = orderedPages(collection)[0]
  if (first === undefined) throw new Error(`Sidebar collection "${collection}" publishes no page.`)
  return routeLink(first.route)
}

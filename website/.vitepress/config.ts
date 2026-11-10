/** VitePress configuration for the locally projected documentation site. */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DefaultTheme, PageData, SiteConfig } from 'vitepress'
import type { ViteDevServer } from 'vite'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { codeGroupFallbackHead, isolateCodeGroupRadios } from './code-groups.ts'
import { landingLink, orderedPages, routeLink, sectionSpec, type DocsPage, type DocsSidebar } from '../docs.ts'
import { docsSourceFiles, emitRawMarkdownPages, llmsTxt, projectDocs } from '../../scripts/project-doc-site.ts'
import { rawMarkdownMiddleware } from '../raw-markdown.ts'

projectDocs()

function sidebar(collection: DocsSidebar): DefaultTheme.SidebarItem[] {
  // `orderedPages` already sorts by section placement, so insertion order
  // carries the group order and each group keeps its pages in sequence.
  const groups = new Map<string, DocsPage[]>()
  for (const page of orderedPages(collection)) {
    const entries = groups.get(page.section) ?? []
    entries.push(page)
    groups.set(page.section, entries)
  }
  return [...groups.entries()].map(([text, entries]) => {
    const { collapsed } = sectionSpec(text)
    return {
      text,
      // A present `collapsed` is what makes the default theme render the
      // group as collapsible at all, so an open group must omit the key.
      ...(collapsed === undefined ? {} : { collapsed }),
      items: entries.map(page => ({ text: page.label, link: routeLink(page.route) })),
    }
  })
}

/**
 * Guide sidebar with direct links into the first development and reference pages.
 *
 * @returns Guide groups followed by top-level links to the other documentation modules.
 */
function guideSidebar(): DefaultTheme.SidebarItem[] {
  return [
    ...sidebar('guide'),
    { text: 'Development', link: landingLink('develop') },
    { text: 'Reference', link: landingLink('reference') },
  ]
}

function watchCanonicalDocs(server: ViteDevServer): void {
  const sources = docsSourceFiles()
  server.watcher.add(sources)
  server.watcher.on('change', (changed) => {
    if (!sources.includes(changed)) return
    projectDocs()
  })
}

/**
 * Serve the raw-Markdown twin of each route and llms.txt during development,
 * matching what `buildEnd` emits into the static build. Pages project from
 * their canonical sources per request, so an edit shows without a rebuild.
 */
function serveRawMarkdown(server: ViteDevServer): void {
  server.middlewares.use(rawMarkdownMiddleware(base, () => llmsTxt({ base, ...siteIdentity })))
}

function escapeVueInterpolation(html: string): string {
  return html.replaceAll('{{', '&#123;&#123;').replaceAll('}}', '&#125;&#125;')
}

/** Site base path, carrying the leading and trailing slashes VitePress requires. */
const base = process.env.DOCS_BASE ?? '/'

/** Site identity shared by the VitePress configuration and the llms.txt index. */
const siteIdentity = {
  title: 'DeepSeek Harness',
  description: 'A plugin-based SDK for building agent harnesses',
}

/**
 * The DeepSeek wordmark, inlined so its `currentColor` fills follow the active
 * theme. An `<img>` would freeze the mark at the colors the file declares.
 */
const wordmark = readFileSync(resolve(import.meta.dirname, '../public/wordmark.svg'), 'utf8')
  .trim()
  .replace('<svg ', '<svg class="dsh-wordmark" ')

/**
 * Head-injected styles for the site identity and sidebar scrollbar.
 *
 * The navigation-bar lockup pairs with `siteTitle`. The scrollbar rules replace
 * the sidebar's platform bar, which reserves 15px of a 265px column and draws a
 * track the rest of the navigation has no border for; `scrollbarScript` supplies
 * the marker that reveals the thumb. Chrome drops `::-webkit-scrollbar` once
 * `scrollbar-width` is set to anything but `auto`, so the standard properties
 * stay behind a query only Firefox answers.
 */
const siteStyle = `
.dsh-lockup { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-wordmark { display: block; height: 22px; width: auto; color: var(--vp-c-text-1); }
.dsh-tag {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--vp-c-brand-soft);
  border-radius: 999px;
  padding: 1px 9px;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
  color: var(--vp-c-brand-1);
}

.VPSidebar::-webkit-scrollbar { width: 6px; }
.VPSidebar::-webkit-scrollbar-track { background: transparent; }
.VPSidebar::-webkit-scrollbar-thumb {
  background-color: transparent;
  border-radius: 3px;
  transition: background-color 0.3s;
}
.VPSidebar[data-scrolling]::-webkit-scrollbar-thumb { background-color: var(--vp-c-text-3); }
@supports not selector(::-webkit-scrollbar) {
  .VPSidebar { scrollbar-width: thin; scrollbar-color: transparent transparent; }
  .VPSidebar[data-scrolling] { scrollbar-color: var(--vp-c-text-3) transparent; }
}
`

/**
 * Mark the sidebar while it scrolls, so its scrollbar rests invisible.
 *
 * A sized `::-webkit-scrollbar` opts the element out of the platform's
 * self-hiding overlay bar, leaving one painted at all times; nothing in CSS
 * reports that an element is scrolling. The listener captures instead of
 * bubbling because scroll events do not bubble, and marks a `data-` attribute
 * rather than a class because Vue rewrites `class` wholesale when it patches
 * the element.
 */
const scrollbarScript = `
(() => {
  let idle
  addEventListener('scroll', (event) => {
    const target = event.target
    if (!(target instanceof Element) || !target.classList.contains('VPSidebar')) return
    target.dataset.scrolling = ''
    clearTimeout(idle)
    idle = setTimeout(() => delete target.dataset.scrolling, 800)
  }, true)
})()
`

/**
 * Navigation-bar title: the DeepSeek wordmark and the release-stage tag.
 * VitePress renders `siteTitle` as HTML.
 *
 * @param previewTag - Release-stage label.
 * @returns Markup placed beside the navigation-bar home link.
 */
function siteTitle(previewTag: string): string {
  return `<span class="dsh-lockup">${wordmark}<span class="dsh-tag">${previewTag}</span></span>`
}

const theme: DefaultTheme.Config = {
  siteTitle: siteTitle('Preview'),
  nav: [
    { text: 'Guide', link: landingLink('guide'), activeMatch: '^/guide/' },
    { text: 'Development', link: landingLink('develop'), activeMatch: '^/develop/' },
    { text: 'Reference', link: landingLink('reference'), activeMatch: '^/reference/' },
  ],
  sidebar: {
    '/guide/': guideSidebar(),
    '/develop/': sidebar('develop'),
    '/reference/': sidebar('reference'),
  },
  search: { provider: 'local' },
  socialLinks: [
    { icon: 'github', link: 'https://github.com/deepseek-ai/deepseek-harness' },
  ],
  editLink: {
    pattern: ({ frontmatter }: PageData) => {
      const data: unknown = frontmatter
      const editSource: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'editSource') : undefined
      if (typeof editSource !== 'string') throw new Error('Projected documentation page has no editSource frontmatter.')
      return `https://github.com/deepseek-ai/deepseek-harness/edit/master/${editSource}`
    },
    text: 'Edit this page on GitHub',
  },
  outline: { label: 'On this page' },
  docFooter: { prev: 'Previous', next: 'Next' },
}

export default withMermaid({
  title: siteIdentity.title,
  description: siteIdentity.description,
  base,
  transformHead: ({ siteConfig }) => codeGroupFallbackHead(siteConfig.mpa),
  /** Emit the raw-Markdown twin of every route plus llms.txt beside the rendered site. */
  buildEnd(siteConfig: SiteConfig) {
    emitRawMarkdownPages(siteConfig.outDir)
    writeFileSync(resolve(siteConfig.outDir, 'llms.txt'), llmsTxt({ base, ...siteIdentity }))
  },
  head: [
    // VitePress leaves head hrefs untouched, so the base belongs here explicitly.
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['style', {}, siteStyle],
    ['script', {}, scrollbarScript],
  ],
  cleanUrls: true,
  srcDir: '.generated',
  cacheDir: '.cache',
  outDir: '.dist',
  lang: 'en-US',
  vite: {
    // `srcDir` puts the Vite root inside the disposable generated tree, whose
    // own `public/` no tracked asset can live in.
    publicDir: resolve(import.meta.dirname, '../public'),
    plugins: [
      {
        name: 'deepseek-harness-doc-projector',
        configureServer(server) {
          watchCanonicalDocs(server)
          serveRawMarkdown(server)
        },
      },
    ],
  },
  markdown: {
    config(md) {
      isolateCodeGroupRadios(md)
      const renderText = md.renderer.rules.text
      const renderCode = md.renderer.rules.code_inline
      const renderFence = md.renderer.rules.fence
      if (renderText === undefined) throw new Error('VitePress Markdown renderer is missing the text rendering rule.')
      if (renderCode === undefined) throw new Error('VitePress Markdown renderer is missing the inline-code rendering rule.')
      if (renderFence === undefined) throw new Error('VitePress Markdown renderer is missing the fence rendering rule.')
      md.renderer.rules.text = (...args) => escapeVueInterpolation(renderText(...args))
      md.renderer.rules.code_inline = (...args) => escapeVueInterpolation(renderCode(...args))
      const renderedFences = new Map<string, string>()
      md.renderer.rules.fence = (...args) => {
        const [tokens, index] = args
        const token = tokens[index]
        if (token === undefined) throw new Error('VitePress code-fence renderer received no token.')
        // Mermaid output embeds the token position, and VitePress snippets resolve source files during rendering.
        if (['mermaid', 'mmd'].includes(token.info.trim().split(/\s+/, 1)[0] ?? '')) return renderFence(...args)
        if (Reflect.get(token, 'src') !== undefined) return renderFence(...args)
        // Keep the cache build-local; a dev renderer can survive many HMR updates.
        if (process.env.NODE_ENV !== 'production') return renderFence(...args)
        const key = JSON.stringify([token.content, token.info, token.markup, token.attrs])
        const cached = renderedFences.get(key)
        if (cached !== undefined) return cached
        const html = renderFence(...args)
        renderedFences.set(key, html)
        return html
      }
    },
  },
  mermaid: {},
  themeConfig: theme,
})

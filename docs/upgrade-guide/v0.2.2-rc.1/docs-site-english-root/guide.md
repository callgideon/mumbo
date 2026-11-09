---
kind: upgrade-guide
description: "The documentation website drops its /en/ route tree and Chinese pages; English pages now live at the site root."
---

# Documentation website serves English at the root

## Change

The documentation website built from `website/` had two route trees. The site root served Simplified Chinese pages, and English pages lived under `/en/`. The site now has one English tree at the root and no language switcher: [website/.vitepress/config.ts](../../../../website/.vitepress/config.ts) sets `lang: 'en-US'` and defines no `locales`, and [website/docs.ts](../../../../website/docs.ts) projects each page once.

- Every former `/en/<path>` page now lives at `/<path>`.
- Root paths keep their URLs; pages that served Chinese now serve the English text.
- Raw Markdown pages follow the same mapping: `/en/<path>.md` becomes `/<path>.md`.
- `llms.txt` lists only the English tree.

| Old URL | New URL |
| --- | --- |
| `/en/` | `/` |
| `/en/guide/quickstart` | `/guide/quickstart` |
| `/en/develop/basic/` | `/develop/basic/` |
| `/en/reference/` | `/reference/` |

The build emits no `/en/` pages, and the site configuration defines no redirect from them. Affected: bookmarks, external links, and agents or tools that fetch `/en/` pages or their raw Markdown.

## Migration

1. Remove the `/en` prefix from each saved or linked documentation URL, keeping the rest of the path and any `#` anchor.
2. Update agents and scripts that fetch raw Markdown from `/en/<path>.md` to fetch `/<path>.md`, or read the page list from `llms.txt`.
3. Confirm the migration: open each updated URL and check that it shows the English page rather than a not-found page.

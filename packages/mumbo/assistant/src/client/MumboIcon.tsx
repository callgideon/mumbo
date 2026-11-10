/** Mumbo's sidebar entry icon; the sidebar owns the button, label, and selected state around it. */
import type { ReactNode } from 'react'
import { IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the shared sparkle glyph at the size the sidebar asks for, until a Mumbo glyph is approved.
 * @param props - the sidebar's icon share: the requested edge and whether the row is selected.
 * @returns the icon element.
 */
export function MumboIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconSparkleRegular size={size} />
}

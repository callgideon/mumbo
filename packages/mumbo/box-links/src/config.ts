/** Box page links shared by the Host and Client halves. */
import z from '@deepseek-ai/schemastery'

/** Absolute links from a box's Web page to the pages the box edge serves beside it. */
export interface Config {
  /** Box home page: the person's assistant, desktop, and shared projects. */
  home: string
  /** Desktop live view; omitted for a box without a desktop, such as a project box. */
  desktop?: string
}

const link = z.string().pattern(/^https?:\/\/[^/\s]+\/\S*$/)

/** Validate both links; each is an absolute HTTP(S) URL with a path, so no script or relative URL reaches the page. */
export const Config: z<Config> = z.object({
  home: link.required().description('Absolute URL of the box home page.'),
  desktop: link.description('Absolute URL of the desktop live view; omit it for a box without a desktop.'),
})

/** Page bootstrap global that carries the validated links to the Client half. */
export const BOX_LINKS_GLOBAL = '__MUMBO_BOX_LINKS__'

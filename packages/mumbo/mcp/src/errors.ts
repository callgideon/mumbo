/** Tool failures the MCP caller can act on. */

/** Machine-readable failure codes returned to the MCP caller. */
export type ToolErrorCode = 'halted' | 'needs_person' | 'request_id_reused' | 'not_found' | 'invalid'

/** An expected tool failure; tool handlers answer it as an `isError` result carrying `code`, never as success. */
export class ToolError extends Error {
  override readonly name = 'ToolError'

  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message)
  }
}

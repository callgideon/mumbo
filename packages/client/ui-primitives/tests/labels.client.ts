import type {
  DiffBlockLabels,
  JsonTreeLabels,
  MarkdownLabels,
  ReadBlockLabels,
  SearchBlockLabels,
  TerminalBlockLabels,
  WebBlockLabels,
} from '../src/index.ts'

export const markdownLabels: MarkdownLabels = {
  code: { copyLabel: 'Copy', copiedLabel: 'Copied' },
  footnotes: 'Footnotes',
}

export const diffBlockLabels: DiffBlockLabels = {
  codeLabel: 'Code block', wrapLabel: 'Line wrap', unwrapLabel: 'CancelLine wrap',
  copy: 'Copy', copied: 'Copied', collapseAria: 'Collapse diff',
  expandAria: hidden => `Expand the remaining \${hidden} more diff lines`,
  collapse: 'Collapse', expand: hidden => `… \${hidden}`,
}

export const readBlockLabels: ReadBlockLabels = {
  codeLabel: 'Code block', wrapLabel: 'Line wrap', unwrapLabel: 'CancelLine wrap',
  window: (shown, total) => `Showing \${shown} / \${total}`,
  copy: 'Copy', copied: 'Copied', collapseAria: 'Collapse content',
  expandAria: hidden => `Expand the remaining \${hidden}`,
  collapse: 'Collapse', expand: hidden => `… \${hidden}`,
}

export const searchBlockLabels: SearchBlockLabels = {
  pathsSummary: (shown, total, truncated) => truncated
    ? `Showing \${shown} of \${total} paths`
    : `\${shown} paths`,
  matchesSummary: (shown, total, files, truncated) => truncated
    ? `Showing \${shown} of \${total} matches · \${files} files`
    : `\${shown} matches · \${files} files`,
  copy: 'Copy', copied: 'Copied', noResults: 'No results',
  collapseAria: 'Collapse results',
  expandAria: hidden => `Expand the remaining \${hidden} more result lines`,
  collapse: 'Collapse', expand: hidden => `… \${hidden}`,
}

export const terminalBlockLabels: TerminalBlockLabels = {
  commandLine: line => `Command line \${line}`,
  signal: signal => `Signal \${signal}`,
  exitCode: code => `Exit code \${code}`,
  noExitCode: 'no exit code',
  running: 'Running', failed: 'Failed', done: 'Done',
  copy: 'Copy', copied: 'Copied', noOutput: 'No output',
  collapseAria: 'Collapse output', collapse: 'Collapse',
  expandAria: hidden => `Expand the remaining \${hidden} output lines`,
  expand: hidden => `… \${hidden}`,
}

export const jsonTreeLabels: JsonTreeLabels = {
  copyValue: 'Copy value', copyJson: 'Copy JSON', copyPath: 'Copy property path',
  copyPrettyJson: 'Copy pretty JSON', copyCompactJson: 'Copy compact JSON',
  copied: 'Copied', copyFailed: 'Copy failed',
  collapseNode: 'Collapse JSON node', expandNode: 'Expand JSON node',
  copyButtonTitle: action => `${action}; right-click for copy options`,
}

export const webBlockLabels: WebBlockLabels = {
  noResults: 'No results found', sourcesTruncated: 'Source list truncated',
  http: 'HTTP', contentTruncated: 'Content truncated', markdown: markdownLabels,
}

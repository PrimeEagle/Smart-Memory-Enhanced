/** Build the click handler used by Export Diagnostics. Read the current report on each click. */
export function createMemorizeDiagnosticsDownload({
  readReport, onUnavailable, document: doc = globalThis.document, url = globalThis.URL,
}) {
  return () => {
    const report = readReport();
    if (!report) return onUnavailable();
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const link = doc.createElement('a');
    const href = url.createObjectURL(blob);
    try {
      link.href = href;
      link.download = 'smart-memory-enhanced-diagnostics.json';
      link.click();
    } finally {
      url.revokeObjectURL(href);
    }
  };
}

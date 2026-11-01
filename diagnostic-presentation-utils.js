/** Presentation-only formatting. Diagnostic rendering must never affect control flow. */
export function formatDiagnosticIdentifier(value, fallback = 'unavailable') {
  const safeFallback = typeof fallback === 'string' && fallback.trim()
    ? fallback.trim() : 'unavailable';
  if (value === null || value === undefined) return safeFallback;
  if (!['string', 'number', 'boolean'].includes(typeof value)) return safeFallback;
  const text = String(value).trim();
  if (!text) return safeFallback;
  return text.replaceAll('_', ' ').replace(/\s+/g, ' ').trim() || safeFallback;
}

export function runNonfatalPresentation(label, render, onFailure = () => {}) {
  try {
    return { ok: true, value: render() };
  } catch (error) {
    const failure = {
      category: 'nonfatal_presentation_failure',
      label: formatDiagnosticIdentifier(label, 'presentation'),
      normalized_exception_class: error?.name ?? 'Error',
      bounded_message: String(error?.message ?? error ?? 'Unknown presentation failure')
        .replace(/\s+/g, ' ').slice(0, 240),
    };
    try { onFailure(failure, error); } catch { /* reporting is nonfatal too */ }
    return { ok: false, value: null, failure };
  }
}

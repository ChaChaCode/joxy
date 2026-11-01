export function maskAddresses(value: string | null | undefined, known: string[], visible = false): string {
  let text = value || '';
  if (visible) return text;
  const hidden = '[адрес скрыт]';
  for (const address of [...new Set(known.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`(?:\\[${escaped}\\]|${escaped})(?::\\d{1,5})?`, 'gi'), hidden);
  }
  // Xray errors can mention peers or DNS addresses which are absent from the profiles.
  return text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, hidden);
}

export const RELEASE_NOTES_CHAR_LIMIT = 500;
export const RELEASE_NOTES_MAX_ITEMS = 12;

export function formatReleaseNotes(tag, notes) {
  const cleanTag = String(tag || '').trim();
  const headline = `${cleanTag} is ready to install`;

  const raw = String(notes || '').replace(/\r\n?/g, '\n');
  const items = [];
  for (const chunk of raw.split('\n')) {
    let line = chunk.trim().replace(/\s+/g, ' ');
    if (!line) continue;
    line = line
      .replace(/^#{1,6}\s*/, '')
      .replace(/^([-*•·]|\d+[.)])\s+/, '')
      .replace(/[*_`~]+/g, '')
      .trim();
    if (!line) continue;
    items.push(`✓ ${line}`);
  }

  let shown = items;
  let overflow = 0;
  if (items.length > RELEASE_NOTES_MAX_ITEMS) {
    shown = items.slice(0, RELEASE_NOTES_MAX_ITEMS);
    overflow = items.length - shown.length;
  }

  let body = headline;
  if (shown.length > 0) {
    body += `\n\n${shown.join('\n')}`;
    if (overflow > 0) body += `\n• …and ${overflow} more`;
  }

  if (body.length > RELEASE_NOTES_CHAR_LIMIT) {
    const cut = body.slice(0, RELEASE_NOTES_CHAR_LIMIT);
    const nl = cut.lastIndexOf('\n');
    body = (nl > headline.length ? cut.slice(0, nl) : cut).trimEnd() + '…';
  }

  return { headline, body };
}

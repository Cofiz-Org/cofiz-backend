export const RELEASE_NOTES_CHAR_LIMIT = 500;
export const RELEASE_NOTES_MAX_ITEMS = 12;

function stripMarkdown(line) {
  return line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^([-*•·]|\d+[.)])\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .trim();
}

export function formatReleaseNotes(tag, notes) {
  const cleanTag = String(tag || '').trim().replace(/\s+/g, ' ');
  const headline = `${cleanTag} is ready to install`;

  const raw = String(notes || '').replace(/\r\n?/g, '\n');
  const items = [];
  for (const chunk of raw.split('\n')) {
    const line = stripMarkdown(chunk.trim().replace(/\s+/g, ' '));
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
    let listed = shown.join('\n');
    const tail = overflow > 0 ? `\n• …and ${overflow} more` : '';
    if ((headline + listed + tail).length > RELEASE_NOTES_CHAR_LIMIT) {
      const room = RELEASE_NOTES_CHAR_LIMIT - headline.length - tail.length;
      const cut = listed.slice(0, Math.max(0, room));
      const nl = cut.lastIndexOf('\n');
      listed = (nl > 0 ? cut.slice(0, nl) : cut).trimEnd() + '…';
    }
    body += `\n\n${listed}${tail}`;
  }

  return { headline, body };
}

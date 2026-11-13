/** SVG outputs are never inserted into HTML. Reject active/external content as defense in depth
 * in addition to the sandboxed media response and the browser's image rendering context. */
export function isSvgPrefix(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
  return /^\s*(?:<\?xml\s[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|\/?>)/i.test(text);
}

// This intentionally accepts a conservative XML subset. SVG files also leave the app via
// downloads, so response CSP alone cannot protect a later standalone viewing of the file.
function assertWellFormedSvg(text: string): void {
  const stack: string[] = [];
  let rootClosed = false;
  let cursor = 0;
  const tokens = /<!--[\s\S]*?-->|<\?xml\s[^?]*\?>|<[^>]*>/g;
  for (const match of text.matchAll(tokens)) {
    const between = text.slice(cursor, match.index);
    if (between.includes('<') || (stack.length === 0 && between.trim()))
      throw new Error('Remote SVG contains malformed XML.');
    cursor = match.index + match[0].length;
    const token = match[0];
    if (token.startsWith('<!--')) {
      if (token.slice(4, -3).includes('--')) throw new Error('Remote SVG contains malformed XML.');
      continue;
    }
    if (token.startsWith('<?xml')) {
      if (stack.length || rootClosed) throw new Error('Remote SVG contains malformed XML.');
      continue;
    }
    const closing = /^<\/([A-Za-z][A-Za-z0-9.-]*)\s*>$/.exec(token);
    if (closing) {
      if (stack.pop() !== closing[1]) throw new Error('Remote SVG contains malformed XML.');
      if (!stack.length) rootClosed = true;
      continue;
    }
    const opening =
      /^<([A-Za-z][A-Za-z0-9.-]*)((?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*)\s*(\/?)>$/.exec(
        token
      );
    if (!opening || rootClosed || (!stack.length && opening[1] !== 'svg'))
      throw new Error('Remote SVG contains malformed or namespaced XML elements.');
    if (opening[3] !== '/') stack.push(opening[1] ?? '');
    else if (!stack.length) rootClosed = true;
  }
  if (stack.length || !rootClosed || text.slice(cursor).trim())
    throw new Error('Remote SVG contains malformed XML.');
}

export function assertSafeSvg(text: string): void {
  if (
    !isSvgPrefix(new TextEncoder().encode(text)) ||
    !/(?:<\/svg\s*>|<svg\b[^<>]*\/>)\s*$/i.test(text)
  )
    throw new Error('Remote SVG did not contain a complete SVG document.');
  // CSS escapes and character references can hide active identifiers from text inspection.
  // Keep named XML text escapes, but reject encoded characters and CSS escapes throughout.
  if (/<style\b|\sstyle\s*=/i.test(text))
    throw new Error(
      'Remote SVG stylesheets and inline styles are unsupported; use presentation attributes.'
    );
  if (
    /\sxmlns(?::[A-Za-z_][A-Za-z0-9_.-]*)?\s*=\s*(?!["']http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink)["'])/i.test(
      text
    )
  )
    throw new Error('Remote SVG contains unsupported namespaces.');
  if (/\\|&#|&(?!amp;|lt;|gt;|quot;|apos;)/.test(text))
    throw new Error('Remote SVG contains encoded active or external content.');
  if (/\s(?:xml:base|[A-Za-z_][A-Za-z0-9_.-]*:base)\s*=/i.test(text))
    throw new Error('Remote SVG contains an external reference base.');
  assertWellFormedSvg(text.replace(/^\uFEFF/, ''));
  if (
    /<!DOCTYPE|<!ENTITY|<\?(?!xml\s)|<(?:[\w.-]+:)?(?:script|foreignObject|iframe|object|embed|audio|video|animate|set|base)\b|\son[\w:-]+\s*=|@import/i.test(
      text
    ) ||
    /\b(?:href|src)\s*=\s*(?!["']#[\w.:-]+["'])/i.test(text) ||
    /(?:image-set|image|src|cross-fade)\s*\(/i.test(text) ||
    /url\s*\(\s*(?!["']?#[\w.:-]+["']?\s*\))/i.test(text)
  )
    throw new Error('Remote SVG contains active or external content.');
}

/** Bound XML inspection independently of the general (larger video) download limit. */
export async function assertSafeSvgFile(path: string): Promise<void> {
  const file = Bun.file(path);
  if (file.size > 32 * 1024 * 1024) throw new Error('Remote SVG exceeds the 32 MB vector limit.');
  assertSafeSvg(await file.text());
}

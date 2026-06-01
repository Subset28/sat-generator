const allowedTags = new Set([
  'p', 'br', 'strong', 'em', 'u', 'sup', 'sub', 'span', 'div', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'blockquote', 'figure', 'figcaption',
  'img', 'a', 'math', 'mi', 'mn', 'mo', 'mrow', 'msup', 'msub', 'mfrac', 'msqrt',
  'mstyle', 'semantics', 'annotation', 'annotation-xml', 'code', 'pre'
]);

const voidTags = new Set(['br', 'img']);
const globalAttrs = new Set(['class', 'id', 'title', 'aria-label', 'aria-hidden', 'role']);
const safeMathAttrs = new Set(['xmlns', 'display', 'mathvariant', 'dir', 'class', 'id', 'href']);
const safeAnchorAttrs = new Set(['href', 'target', 'rel', 'title', 'class', 'id']);
const safeImageAttrs = new Set(['src', 'alt', 'width', 'height', 'loading', 'decoding', 'class', 'id', 'data-asset-id']);
const safeTableAttrs = new Set(['class', 'id', 'colspan', 'rowspan', 'scope']);

function decodeEntities(value) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    rsquo: '’',
    lsquo: '‘',
    rdquo: '”',
    ldquo: '“',
    ndash: '–',
    mdash: '—',
    hellip: '…',
    minus: '−',
    times: '×',
    divide: '÷',
    frac12: '½'
  };
  return String(value)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&nbsp;', ' ')
    .replace(/&#(\d+);/g, (_, code) => {
      const point = Number(code);
      return Number.isFinite(point) ? String.fromCodePoint(point) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const point = Number.parseInt(code, 16);
      return Number.isFinite(point) ? String.fromCodePoint(point) : _;
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (_, name) => named[name] || `&${name};`);
}

function encodeText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function parseAttributes(raw) {
  const attrs = [];
  const pattern = /([a-zA-Z_:][a-zA-Z0-9_:\-\.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>/=`]+)))?/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    attrs.push({
      name: match[1],
      value: decodeEntities(match[3] ?? match[4] ?? match[5] ?? '')
    });
  }
  return attrs;
}

function allowAttr(tag, name) {
  const lower = name.toLowerCase();
  if (lower.startsWith('on')) return false;
  if (lower.startsWith('data-')) return true;
  if (lower.startsWith('aria-')) return true;
  if (globalAttrs.has(lower)) return true;
  if (tag === 'a') return safeAnchorAttrs.has(lower);
  if (tag === 'img') return safeImageAttrs.has(lower);
  if (tag === 'math' || tag === 'mi' || tag === 'mn' || tag === 'mo' || tag === 'mrow' || tag === 'msup' || tag === 'msub' || tag === 'mfrac' || tag === 'msqrt' || tag === 'mstyle' || tag === 'semantics' || tag === 'annotation' || tag === 'annotation-xml') {
    return safeMathAttrs.has(lower) || lower.startsWith('data-') || lower.startsWith('aria-');
  }
  if (tag === 'table' || tag === 'thead' || tag === 'tbody' || tag === 'tr' || tag === 'td' || tag === 'th' || tag === 'figure' || tag === 'figcaption') {
    return safeTableAttrs.has(lower);
  }
  return false;
}

function sanitizeAttributes(tag, rawAttrs) {
  const attrs = parseAttributes(rawAttrs);
  const kept = [];
  for (const attr of attrs) {
    if (!allowAttr(tag, attr.name)) continue;
    const lower = attr.name.toLowerCase();
    let value = String(attr.value ?? '');
    if (lower === 'href' || lower === 'src') {
      const trimmed = value.trim();
      if (!trimmed || /^javascript:/i.test(trimmed) || /^data:text\/html/i.test(trimmed)) continue;
      value = trimmed;
    }
    if (lower === 'target' && !['_blank', '_self', '_parent', '_top'].includes(value)) {
      continue;
    }
    if (lower === 'rel' && tag === 'a' && !value) {
      value = 'noopener noreferrer';
    }
    kept.push(`${attr.name}="${escapeHtmlAttr(value)}"`);
  }
  if (tag === 'a' && !kept.some((entry) => entry.toLowerCase().startsWith('rel='))) {
    kept.push('rel="noopener noreferrer"');
  }
  return kept.length ? ` ${kept.join(' ')}` : '';
}

function escapeHtmlAttr(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function sanitizeHtml(input) {
  const source = String(input ?? '');
  const tokenPattern = /<\/?([a-zA-Z0-9:-]+)([^>]*)>|([^<]+)/g;
  const openStack = [];
  let output = '';
  let match;

  while ((match = tokenPattern.exec(source)) !== null) {
    const [token, tagName, rawAttrs, text] = match;
    if (text) {
      output += encodeText(decodeEntities(text));
      continue;
    }

    const lowerTag = String(tagName).toLowerCase();
    if (!allowedTags.has(lowerTag)) {
      continue;
    }

    const isClosing = token.startsWith('</');
    const isSelfClosing = /\/>$/.test(token) || voidTags.has(lowerTag);

    if (isClosing) {
      let popped = null;
      while (openStack.length) {
        const candidate = openStack.pop();
        if (candidate === lowerTag) {
          popped = candidate;
          break;
        }
      }
      if (popped) {
        output += `</${popped}>`;
      }
      continue;
    }

    const attrs = sanitizeAttributes(lowerTag, rawAttrs || '');
    if (isSelfClosing) {
      output += `<${lowerTag}${attrs}>`;
      continue;
    }

    openStack.push(lowerTag);
    output += `<${lowerTag}${attrs}>`;
  }

  while (openStack.length) {
    output += `</${openStack.pop()}>`;
  }

  return output;
}

function stripHtml(input) {
  return decodeEntities(String(input ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

module.exports = {
  sanitizeHtml,
  stripHtml
};

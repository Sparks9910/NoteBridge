import { createAppError } from '../../domain/state-machines.ts';
import type { Result } from '../../domain/types.ts';

export interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function decodeXmlEntities(raw: string): string {
  return raw.replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
    (_full, entity: string) => {
      if (entity === 'amp') return '&';
      if (entity === 'lt') return '<';
      if (entity === 'gt') return '>';
      if (entity === 'quot') return '"';
      if (entity === 'apos') return "'";
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        const cp = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : '';
      }
      if (entity.startsWith('#')) {
        const cp = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : '';
      }
      return '';
    }
  );
}

function parseAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null = attrRe.exec(attrText);
  while (match) {
    const key = match[1];
    const val = match[2] ?? match[3] ?? '';
    if (key) {
      attrs[key] = decodeXmlEntities(val);
    }
    match = attrRe.exec(attrText);
  }
  return attrs;
}

function stripLocalName(rawName: string): string {
  const idx = rawName.indexOf(':');
  return idx >= 0 ? rawName.slice(idx + 1) : rawName;
}

/**
 * 零依赖纯 TypeScript XML 解析器，兼容浏览器与 Node.js 环境。
 */
export function parseXml(rawXml: string): Result<XmlElement> {
  if (typeof rawXml !== 'string' || rawXml.trim().length === 0) {
    return {
      ok: false,
      error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'XML 文件内容为空，无法解析'),
    };
  }

  const src = rawXml.charCodeAt(0) === 0xfeff ? rawXml.slice(1) : rawXml;
  const len = src.length;
  let pos = 0;

  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;

  while (pos < len) {
    const lt = src.indexOf('<', pos);
    if (lt === -1) {
      const trailing = src.slice(pos).trim();
      if (trailing.length > 0 && stack.length > 0) {
        stack[stack.length - 1]!.text += decodeXmlEntities(trailing);
      }
      break;
    }

    if (lt > pos) {
      const textChunk = src.slice(pos, lt);
      if (stack.length > 0) {
        stack[stack.length - 1]!.text += decodeXmlEntities(textChunk);
      } else if (textChunk.trim().length > 0) {
        return {
          ok: false,
          error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'XML 根节点外存在非法文本内容'),
        };
      }
    }

    // Comment <!-- ... -->
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end === -1) {
        return {
          ok: false,
          error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'XML 注释未正确闭合'),
        };
      }
      pos = end + 3;
      continue;
    }

    // CDATA <![CDATA[ ... ]]>
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end === -1) {
        return {
          ok: false,
          error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'XML CDATA 段落未正确闭合'),
        };
      }
      if (stack.length > 0) {
        stack[stack.length - 1]!.text += src.slice(lt + 9, end);
      }
      pos = end + 3;
      continue;
    }

    // Processing instruction <?...?>
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end === -1) {
        return {
          ok: false,
          error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'XML 声明指令未正确闭合'),
        };
      }
      pos = end + 2;
      continue;
    }

    // DOCTYPE or <!...>
    if (src.startsWith('<!', lt)) {
      let cursor = lt + 2;
      let inBracket = false;
      let quote: string | null = null;
      while (cursor < len) {
        const ch = src[cursor];
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === '[') {
          inBracket = true;
        } else if (ch === ']') {
          inBracket = false;
        } else if (ch === '>' && !inBracket) {
          break;
        }
        cursor += 1;
      }
      if (cursor >= len) {
        return {
          ok: false,
          error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'XML 文档类型声明未闭合'),
        };
      }
      pos = cursor + 1;
      continue;
    }

    // Normal open or close tag: find '>' respecting quotes
    let gt = lt + 1;
    let quote: string | null = null;
    while (gt < len) {
      const ch = src[gt];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      gt += 1;
    }
    if (gt >= len) {
      return {
        ok: false,
        error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'XML 标签未正确闭合'),
      };
    }

    const rawTag = src.slice(lt + 1, gt).trim();
    pos = gt + 1;

    if (rawTag.length === 0) {
      return {
        ok: false,
        error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'XML 存在空标签'),
      };
    }

    // Closing tag </tag>
    if (rawTag.startsWith('/')) {
      const closeName = stripLocalName(rawTag.slice(1).trim());
      const top = stack.pop();
      if (!top || top.tag !== closeName) {
        return {
          ok: false,
          error: createAppError(
            'STORAGE_SCHEMA_CORRUPTED',
            `XML 标签嵌套错误，期望闭合 ${top?.tag ?? '无'} 但遇到 ${closeName}`
          ),
        };
      }
      top.text = top.text.trim();
      continue;
    }

    const isSelfClosing = rawTag.endsWith('/');
    const body = isSelfClosing ? rawTag.slice(0, -1).trim() : rawTag;
    const spaceIdx = body.search(/\s/);
    const rawName = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
    const attrPart = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1);
    const tag = stripLocalName(rawName);

    const element: XmlElement = {
      tag,
      attrs: parseAttributes(attrPart),
      children: [],
      text: '',
    };

    if (stack.length > 0) {
      stack[stack.length - 1]!.children.push(element);
    } else if (!root) {
      root = element;
    } else {
      return {
        ok: false,
        error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'XML 存在多个根元素'),
      };
    }

    if (!isSelfClosing) {
      stack.push(element);
    }
  }

  if (stack.length > 0 || !root) {
    return {
      ok: false,
      error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'XML 文档结构不完整，缺少根节点或闭合标签'),
    };
  }

  return { ok: true, value: root };
}

export function findChild(parent: XmlElement, tag: string): XmlElement | undefined {
  return parent.children.find((c) => c.tag === tag);
}

export function findChildren(parent: XmlElement, tag: string): XmlElement[] {
  return parent.children.filter((c) => c.tag === tag);
}

export function childText(parent: XmlElement, tag: string): string | undefined {
  const child = findChild(parent, tag);
  return child ? child.text : undefined;
}

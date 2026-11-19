'use client';

/**
 * Safe, zero-dependency Markdown renderer for assistant chat turns.
 *
 * Parses headings, bullet/numbered lists, bold/italic/code spans, and links
 * directly into React elements without `dangerouslySetInnerHTML`, blocking
 * unsafe URL schemes (`javascript:`, `data:`) so model output cannot inject XSS.
 */

import React from 'react';

interface MarkdownTextProps {
  text: string;
}

function sanitizeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('/')) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenRe =
    /(`[^`]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\n]+\))/g;
  let lastIndex = 0;
  let tokenIdx = 0;

  for (const match of text.matchAll(tokenRe)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      nodes.push(text.slice(lastIndex, matchIndex));
    }

    const token = match[0];
    const key = `${keyPrefix}-${tokenIdx++}`;

    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code key={key} className="md-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(
        <strong key={key}>
          {renderInline(token.slice(2, -2), `${key}-b`)}
        </strong>,
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(
        <em key={key}>{renderInline(token.slice(1, -1), `${key}-i`)}</em>,
      );
    } else if (token.startsWith('[')) {
      const splitIdx = token.indexOf('](');
      const label = splitIdx > 1 ? token.slice(1, splitIdx) : token;
      const rawUrl = splitIdx > 1 ? token.slice(splitIdx + 2, -1) : '';
      const safeHref = sanitizeHref(rawUrl);
      if (safeHref) {
        const isExternal = safeHref.startsWith('http');
        nodes.push(
          <a
            key={key}
            href={safeHref}
            className="md-link"
            {...(isExternal
              ? { target: '_blank', rel: 'noopener noreferrer' }
              : {})}
          >
            {label}
          </a>,
        );
      } else {
        nodes.push(label);
      }
    } else {
      nodes.push(token);
    }

    lastIndex = matchIndex + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) {
    return false;
  }
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const UL_RE = /^[-*]\s+(.+)$/;
const OL_RE = /^\d+\.\s+(.+)$/;

function isBlockStarter(line: string, nextLine: string | undefined): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }
  if (
    trimmed.startsWith('```') ||
    HEADING_RE.test(trimmed) ||
    UL_RE.test(trimmed) ||
    OL_RE.test(trimmed)
  ) {
    return true;
  }
  if (trimmed.includes('|') && nextLine !== undefined && isTableSeparator(nextLine)) {
    return true;
  }
  return false;
}

export function MarkdownText({ text }: MarkdownTextProps) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        i += 1;
      }
      blocks.push(
        <pre key={`code-${blocks.length}`} className="md-code-block">
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const headingMatch = HEADING_RE.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = renderInline(headingMatch[2], `h-${blocks.length}`);
      if (level <= 3) {
        blocks.push(
          <h3 key={`h-${blocks.length}`} className="md-h3">
            {content}
          </h3>,
        );
      } else {
        blocks.push(
          <h4 key={`h-${blocks.length}`} className="md-h4">
            {content}
          </h4>,
        );
      }
      i += 1;
      continue;
    }

    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = parseTableRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim() !== '') {
        rows.push(parseTableRow(lines[i]));
        i += 1;
      }
      const tableKey = `tbl-${blocks.length}`;
      blocks.push(
        <div key={tableKey} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {headers.map((cell, ci) => (
                  <th key={`${tableKey}-h-${ci}`}>
                    {renderInline(cell, `${tableKey}-hc-${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={`${tableKey}-r-${ri}`}>
                  {headers.map((_, ci) => (
                    <td key={`${tableKey}-c-${ri}-${ci}`}>
                      {renderInline(row[ci] ?? '', `${tableKey}-cell-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (UL_RE.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = UL_RE.exec(lines[i].trim());
        if (!m) {
          break;
        }
        items.push(m[1]);
        i += 1;
      }
      const listKey = `ul-${blocks.length}`;
      blocks.push(
        <ul key={listKey} className="md-list">
          {items.map((item, idx) => (
            <li key={`${listKey}-${idx}`}>
              {renderInline(item, `${listKey}-li-${idx}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (OL_RE.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = OL_RE.exec(lines[i].trim());
        if (!m) {
          break;
        }
        items.push(m[1]);
        i += 1;
      }
      const listKey = `ol-${blocks.length}`;
      blocks.push(
        <ol key={listKey} className="md-list md-list-ordered">
          {items.map((item, idx) => (
            <li key={`${listKey}-${idx}`}>
              {renderInline(item, `${listKey}-li-${idx}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    const paraLines: string[] = [trimmed];
    i += 1;
    while (i < lines.length && !isBlockStarter(lines[i], lines[i + 1])) {
      paraLines.push(lines[i].trim());
      i += 1;
    }
    const paraKey = `p-${blocks.length}`;
    blocks.push(
      <p key={paraKey} className="md-p">
        {renderInline(paraLines.join(' '), paraKey)}
      </p>,
    );
  }

  return <div className="assistant-prose">{blocks}</div>;
}

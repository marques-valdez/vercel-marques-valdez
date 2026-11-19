'use client';

/**
 * Opt-in Architect X-Ray wire frame inspector (`x-vercel-ai-ui-message-stream: v1`).
 *
 * Consumes frames tapped via `response.body.tee()` in `WorkspaceClient` and
 * pairs each live SSE frame (`start`, `tool-input-available`, `data-telemetry`,
 * `finish`) with the exact lines of `backend/app/ui_stream.py` that emitted it.
 */

import React, { useMemo, useState } from 'react';
import type { WireFrameRecord } from '@/lib/types';

interface ProtocolXRayProps {
  frames: WireFrameRecord[];
  uiStreamSource: string;
  defaultOpen?: boolean;
}

interface SourceExcerpt {
  heading: string;
  startLine: number;
  lines: string[];
}

function findMatchingPythonLines(
  source: string,
  frameType: string,
): SourceExcerpt {
  const allLines = source.split('\n');
  const needlesByType: Record<string, string[]> = {
    start: ['"type": "start"', '"type":"start"'],
    'start-step': ['"type": "start-step"', '"step_start"'],
    'text-start': ['"type": "text-start"'],
    'text-delta': ['"type": "text-delta"'],
    'text-end': ['"type": "text-end"'],
    'tool-input-available': ['"type": "tool-input-available"'],
    'data-sandbox-status': ['"type": "data-sandbox-status"'],
    'tool-output-available': ['"type": "tool-output-available"'],
    'tool-output-error': ['"type": "tool-output-error"'],
    'data-telemetry': ['"type": "data-telemetry"'],
    'finish-step': ['"type": "finish-step"'],
    finish: ['"type": "finish"'],
    error: ['"type": "error"'],
    '[DONE]': ['DONE_SSE'],
  };

  const needles = needlesByType[frameType] ?? ['format_sse'];
  let matchIdx = -1;
  for (let i = 0; i < allLines.length; i += 1) {
    if (needles.some((needle) => allLines[i].includes(needle))) {
      matchIdx = i;
      break;
    }
  }

  if (matchIdx === -1) {
    return {
      heading: 'backend/app/ui_stream.py · format_sse',
      startLine: 1,
      lines: allLines.slice(0, 14),
    };
  }

  const from = Math.max(0, matchIdx - 3);
  const to = Math.min(allLines.length, matchIdx + 9);
  return {
    heading: `backend/app/ui_stream.py · lines ${from + 1}–${to}`,
    startLine: from + 1,
    lines: allLines.slice(from, to),
  };
}

export function ProtocolXRay({
  frames,
  uiStreamSource,
  defaultOpen = false,
}: ProtocolXRayProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [copied, setCopied] = useState(false);

  const safeIndex = Math.min(selectedIndex, Math.max(0, frames.length - 1));
  const selectedFrame = frames[safeIndex] ?? null;

  const excerpt = useMemo(() => {
    if (!selectedFrame) {
      return null;
    }
    return findMatchingPythonLines(uiStreamSource, selectedFrame.type);
  }, [selectedFrame, uiStreamSource]);

  if (frames.length === 0) {
    return null;
  }

  const handleCopy = async () => {
    const rawLog = frames.map((frame) => `data: ${frame.raw}`).join('\n\n');
    try {
      await navigator.clipboard.writeText(rawLog);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="xray-wrapper" data-testid="protocol-xray">
      <div className="xray-trigger-row">
        <button
          type="button"
          className={open ? 'btn-chip btn-chip-active mono-text' : 'btn-chip mono-text'}
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          data-testid="turn-xray-toggle"
        >
          {open
            ? `Hide SSE wire (${frames.length} frames)`
            : `<> SSE wire (${frames.length} frames)`}
        </button>
        <span className="xray-protocol-note mono-text">
          x-vercel-ai-ui-message-stream: v1
        </span>
      </div>

      {open ? (
        <section
          className="xray-panel"
          aria-label="SSE UI Message Stream Protocol X-Ray"
          data-testid="protocol-xray-panel"
        >
          <div className="xray-col">
            <div className="xray-col-header">
              <span className="tool-card-eyebrow">CAPTURED WIRE FRAMES</span>
              <button
                type="button"
                className="btn-chip mono-text"
                onClick={() => void handleCopy()}
                data-testid="xray-copy-button"
              >
                {copied ? '✓ Copied!' : 'Copy SSE'}
              </button>
            </div>
            <ul className="xray-frame-list tabular-nums">
              {frames.map((frame, idx) => (
                <li key={frame.id}>
                  <button
                    type="button"
                    className={
                      idx === safeIndex
                        ? 'xray-frame-row xray-frame-row-active mono-text'
                        : 'xray-frame-row mono-text'
                    }
                    onClick={() => setSelectedIndex(idx)}
                  >
                    <span className="xray-offset">{`+${frame.offsetMs}ms`}</span>
                    <span className="xray-type">{frame.type}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="xray-col">
            <div className="xray-col-header">
              <span className="tool-card-eyebrow">
                {excerpt ? excerpt.heading : 'PYTHON EMITTER'}
              </span>
            </div>
            {selectedFrame ? (
              <div className="xray-detail-stack">
                <pre className="code-block xray-code mono-text">
                  <code>{`data: ${selectedFrame.raw}`}</code>
                </pre>
                {excerpt ? (
                  <pre className="code-block xray-code mono-text">
                    <code>
                      {excerpt.lines
                        .map((line, idx) => `${String(excerpt.startLine + idx).padStart(3, ' ')} | ${line}`)
                        .join('\n')}
                    </code>
                  </pre>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

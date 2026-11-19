'use client';

import React, { useEffect, useState } from 'react';
import { CANONICAL_CHANNELS, CHANNEL_LABELS, PLAYBOOKS } from '@/lib/playbooks';
import { encodePlaybookSlug, resolvePlaybookSlug } from '@/lib/share';
import type { ChannelId, PlaybookId } from '@/lib/types';

interface ShareModalProps {
  isOpen: boolean;
  initialSlug: string;
  onClose: () => void;
}

export function ShareModal({ isOpen, initialSlug, onClose }: ShareModalProps) {
  const initialResolved =
    resolvePlaybookSlug(initialSlug) ?? resolvePlaybookSlug('creative-404-guard')!;

  const [template, setTemplate] = useState<PlaybookId>(initialResolved.template);
  const [channels, setChannels] = useState<ChannelId[]>(initialResolved.channels);
  const [threshold, setThreshold] = useState<number>(initialResolved.threshold);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setOrigin(window.location.origin);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const nextResolved =
      resolvePlaybookSlug(initialSlug) ?? resolvePlaybookSlug('creative-404-guard')!;
    setTemplate(nextResolved.template);
    setChannels(nextResolved.channels);
    setThreshold(nextResolved.threshold);
    setCopied(false);
  }, [isOpen, initialSlug]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  const clampedThreshold = Number.isFinite(threshold)
    ? Math.min(100, Math.max(1, Math.round(threshold)))
    : 10;
  const safeChannels: ChannelId[] =
    channels.length > 0 ? channels : ['google_ads'];

  const activeSlug = encodePlaybookSlug({
    template,
    channels: safeChannels,
    threshold: clampedThreshold,
  });

  const sharePath = `/p/${activeSlug}`;
  const fullShareUrl = origin ? `${origin}${sharePath}` : sharePath;
  const ogImageUrl = `/api/og?slug=${encodeURIComponent(activeSlug)}`;
  const activePlaybookMeta =
    PLAYBOOKS.find((item) => item.id === template) ?? PLAYBOOKS[0];

  const handleChannelToggle = (channelId: ChannelId) => {
    setCopied(false);
    setChannels((prev) => {
      if (prev.includes(channelId)) {
        if (prev.length === 1) {
          return prev;
        }
        return prev.filter((item) => item !== channelId);
      }
      return CANONICAL_CHANNELS.filter(
        (canonical) => prev.includes(canonical) || canonical === channelId,
      );
    });
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullShareUrl);
      setCopied(true);
    } catch {
      const helper = document.createElement('textarea');
      helper.value = fullShareUrl;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      try {
        helper.select();
        document.execCommand('copy');
        setCopied(true);
      } catch {
        // Ignore fallback clipboard restrictions
      } finally {
        document.body.removeChild(helper);
      }
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-modal-title"
        data-testid="share-modal"
      >
        <div className="modal-header">
          <div>
            <div className="tool-card-eyebrow">SHARE WITH YOUR TEAM</div>
            <h2 id="share-modal-title" className="modal-title">
              Share campaign playbook
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            aria-label="Close share dialog"
          >
            Close
          </button>
        </div>

        <div className="modal-controls-grid">
          <div className="field-group">
            <label htmlFor="share-template-select" className="field-label">
              Campaign check
            </label>
            <select
              id="share-template-select"
              className="field-select"
              value={template}
              onChange={(e) => {
                const nextId = e.target.value as PlaybookId;
                const found = PLAYBOOKS.find((p) => p.id === nextId);
                setTemplate(nextId);
                if (found) {
                  setThreshold(found.defaultThreshold);
                  setChannels([...found.defaultChannels]);
                }
                setCopied(false);
              }}
            >
              {PLAYBOOKS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </div>

          <div className="field-group">
            <label htmlFor="share-threshold-input" className="field-label">
              Wasted-spend alert rule (%)
            </label>
            <div className="threshold-input-pair">
              <input
                type="range"
                min={1}
                max={100}
                aria-label="Alert threshold slider"
                className="field-range"
                value={clampedThreshold}
                onChange={(e) => {
                  const parsed = Number.parseInt(e.target.value, 10);
                  setThreshold(Number.isFinite(parsed) ? parsed : 10);
                  setCopied(false);
                }}
                data-testid="share-threshold-slider"
              />
              <input
                id="share-threshold-input"
                type="number"
                min={1}
                max={100}
                className="field-input threshold-number-input tabular-nums"
                value={clampedThreshold}
                onChange={(e) => {
                  const parsed = Number.parseInt(e.target.value, 10);
                  setThreshold(Number.isFinite(parsed) ? parsed : 10);
                  setCopied(false);
                }}
              />
            </div>
          </div>
        </div>

        <fieldset className="channel-fieldset">
          <legend className="field-label">Included ad channels</legend>
          <div className="channel-checkbox-row">
            {CANONICAL_CHANNELS.map((ch) => {
              const checked = safeChannels.includes(ch);
              return (
                <label key={ch} className="checkbox-pill">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => handleChannelToggle(ch)}
                  />
                  <span>{CHANNEL_LABELS[ch]}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="share-url-row">
          <input
            type="text"
            readOnly
            value={fullShareUrl}
            aria-label="Shareable playbook URL"
            className="field-input mono-text share-url-input"
            data-testid="share-url-input"
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleCopy()}
            data-testid="share-copy-button"
          >
            {copied ? '✓ Copied!' : 'Copy link'}
          </button>
          <a href={sharePath} className="btn btn-secondary">
            Open page
          </a>
        </div>

        <div className="og-preview-frame">
          <div className="og-preview-header">
            <div className="field-label">Slack &amp; social link preview</div>
          </div>
          <div className="og-unfurl-card">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={ogImageUrl}
              width={1200}
              height={630}
              alt="Playbook link preview card"
              className="og-preview-img"
              data-testid="share-og-preview"
            />
            <div className="og-unfurl-meta">
              <div className="og-unfurl-domain">
                {origin ? origin.replace(/^https?:\/\//, '') : 'relay-studio.vercel.app'}
              </div>
              <div className="og-unfurl-title">
                {`${activePlaybookMeta.title} · Fieldstone / Relay Studio`}
              </div>
              <div className="og-unfurl-desc">{activePlaybookMeta.summary}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

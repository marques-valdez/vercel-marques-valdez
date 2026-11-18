import { z } from 'zod';
import { CANONICAL_CHANNELS, PLAYBOOKS_BY_ID } from './playbooks';
import type { ChannelId, PlaybookId, ResolvedPlaybook } from './types';

export const PlaybookTemplateSchema = z.enum([
  'creative-404-guard',
  'cross-channel-roas',
  'paid-social-reallocation',
  'daily-pacing-guardrail',
]);

export const ChannelIdSchema = z.enum(['google_ads', 'linkedin_ads', 'meta_ads']);

export const CustomSlugPayloadSchema = z
  .object({
    template: PlaybookTemplateSchema,
    channels: z
      .array(ChannelIdSchema)
      .min(1)
      .max(3)
      .refine((items) => new Set(items).size === items.length, {
        message: 'Duplicate channels are not permitted',
      }),
    threshold: z.number().int().min(1).max(100),
  })
  .strict();

export type CustomSlugPayload = z.infer<typeof CustomSlugPayloadSchema>;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(slug: string): Uint8Array | null {
  if (!slug || slug.length > 512) {
    return null;
  }
  if (!/^[A-Za-z\d_-]+$/.test(slug)) {
    return null;
  }
  const mod = slug.length % 4;
  if (mod === 1) {
    return null;
  }
  const padLength = mod === 0 ? 0 : 4 - mod;
  const standardBase64 =
    slug.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLength);
  let binary = '';
  try {
    binary = atob(standardBase64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  if (bytesToBase64Url(bytes) !== slug) {
    return null;
  }
  return bytes;
}

export function encodeCustomPlaybookSlug(input: CustomSlugPayload): string {
  const orderedChannels = CANONICAL_CHANNELS.filter((ch) =>
    input.channels.includes(ch),
  );
  const validated = CustomSlugPayloadSchema.parse({
    template: input.template,
    channels: orderedChannels,
    threshold: input.threshold,
  });
  const json = JSON.stringify({
    template: validated.template,
    channels: validated.channels,
    threshold: validated.threshold,
  });
  const bytes = new TextEncoder().encode(json);
  return bytesToBase64Url(bytes);
}

export const CANONICAL_PLAYBOOK_SLUGS: Record<PlaybookId, string> = {
  'creative-404-guard': encodeCustomPlaybookSlug({
    template: 'creative-404-guard',
    channels: ['google_ads', 'linkedin_ads', 'meta_ads'],
    threshold: PLAYBOOKS_BY_ID['creative-404-guard'].defaultThreshold,
  }),
  'cross-channel-roas': encodeCustomPlaybookSlug({
    template: 'cross-channel-roas',
    channels: ['google_ads', 'linkedin_ads', 'meta_ads'],
    threshold: PLAYBOOKS_BY_ID['cross-channel-roas'].defaultThreshold,
  }),
  'paid-social-reallocation': encodeCustomPlaybookSlug({
    template: 'paid-social-reallocation',
    channels: ['google_ads', 'linkedin_ads', 'meta_ads'],
    threshold: PLAYBOOKS_BY_ID['paid-social-reallocation'].defaultThreshold,
  }),
  'daily-pacing-guardrail': encodeCustomPlaybookSlug({
    template: 'daily-pacing-guardrail',
    channels: ['google_ads', 'linkedin_ads', 'meta_ads'],
    threshold: PLAYBOOKS_BY_ID['daily-pacing-guardrail'].defaultThreshold,
  }),
};

export function encodePlaybookSlug(
  input: CustomSlugPayload,
  options?: { preferAlias?: boolean },
): string {
  const orderedChannels = CANONICAL_CHANNELS.filter((ch) =>
    input.channels.includes(ch),
  );
  const definition = PLAYBOOKS_BY_ID[input.template];
  const isDefaultChannels =
    orderedChannels.length === definition.defaultChannels.length &&
    orderedChannels.every((ch, idx) => ch === definition.defaultChannels[idx]);

  if (
    options?.preferAlias !== false &&
    isDefaultChannels &&
    input.threshold === definition.defaultThreshold
  ) {
    return input.template;
  }
  return encodeCustomPlaybookSlug({
    template: input.template,
    channels: orderedChannels,
    threshold: input.threshold,
  });
}

export function resolvePlaybookSlug(slug: string): ResolvedPlaybook | null {
  if (typeof slug !== 'string' || slug.length === 0 || slug.length > 512) {
    return null;
  }

  if (Object.hasOwn(PLAYBOOKS_BY_ID, slug)) {
    const templateId = slug as PlaybookId;
    const def = PLAYBOOKS_BY_ID[templateId];
    return {
      slug,
      template: def.id,
      eyebrow: def.eyebrow,
      title: def.title,
      summary: def.summary,
      prompt: def.prompt,
      tierHint: def.tierHint,
      channels: [...def.defaultChannels],
      threshold: def.defaultThreshold,
      steps: [...def.steps],
    };
  }

  const bytes = base64UrlToBytes(slug);
  if (!bytes) {
    return null;
  }

  let rawJson = '';
  try {
    rawJson = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }

  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(rawJson);
  } catch {
    return null;
  }

  const validated = CustomSlugPayloadSchema.safeParse(parsedUnknown);
  if (!validated.success) {
    return null;
  }

  if (JSON.stringify(parsedUnknown) !== rawJson) {
    return null;
  }

  const payload = validated.data;
  const def = PLAYBOOKS_BY_ID[payload.template];
  const orderedChannels: ChannelId[] = CANONICAL_CHANNELS.filter((ch) =>
    payload.channels.includes(ch),
  );

  return {
    slug,
    template: def.id,
    eyebrow: def.eyebrow,
    title: def.title,
    summary: def.summary,
    prompt: def.prompt,
    tierHint: def.tierHint,
    channels: orderedChannels,
    threshold: payload.threshold,
    steps: [...def.steps],
  };
}

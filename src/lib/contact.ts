import { parsePublicId } from './crypto-core';

export const CONTACT_CODE_PREFIX = 'protestchat:';
export const MAX_CONTACT_NAME_LENGTH = 32;

/** Accepts either the raw public id or the exact QR/paste representation. */
export function publicIdFromContactCode(raw: string): string | null {
  const value = raw.trim();
  const publicId = value.startsWith(CONTACT_CODE_PREFIX)
    ? value.slice(CONTACT_CODE_PREFIX.length)
    : value;
  return parsePublicId(publicId)?.publicId ?? null;
}

/** Names are local aliases. Empty aliases are rejected instead of becoming indistinguishable. */
export function cleanContactName(raw: string): string | null {
  const value = Array.from(raw.trim()).slice(0, MAX_CONTACT_NAME_LENGTH).join('');
  return value || null;
}

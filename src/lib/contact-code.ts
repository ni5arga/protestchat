/**
 * Contact introduction codes (QR / paste).
 *
 * v1: protestchat:<publicId>
 * v2: protestchat:v2:<publicId>:<signedReceiveKey>
 *
 * v2 carries a signed receive key so the scanner can seal with forward secrecy
 * from the first message, without a key-distribution server.
 */

import type { PublicIdentity, SignedReceiveKey } from './crypto-core';
import {
  decodeSignedReceiveKey,
  encodeSignedReceiveKey,
  parsePublicId,
  verifyReceiveKey,
} from './crypto-core';

export const CONTACT_CODE_PREFIX = 'protestchat:';

export type ContactCode = {
  identity: PublicIdentity;
  /** Present when the code was v2 and the signature verified. */
  receiveKey: SignedReceiveKey | null;
};

/** Build a v2 code when we have a signed receive key; otherwise v1. */
export function encodeContactCode(
  publicId: string,
  signedReceiveKey?: SignedReceiveKey | null,
): string {
  if (signedReceiveKey) {
    return `${CONTACT_CODE_PREFIX}v2:${publicId}:${encodeSignedReceiveKey(signedReceiveKey)}`;
  }
  return `${CONTACT_CODE_PREFIX}${publicId}`;
}

/**
 * Parse a pasted/scanned code. Invalid receive-key signatures are rejected
 * entirely — better to fail introduction than store an attacker-chosen key.
 */
export function decodeContactCode(raw: string): ContactCode | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(CONTACT_CODE_PREFIX)) {
    // Bare publicId (typed without prefix) — still accept.
    const identity = parsePublicId(trimmed);
    return identity ? { identity, receiveKey: null } : null;
  }

  const rest = trimmed.slice(CONTACT_CODE_PREFIX.length);

  if (rest.startsWith('v2:')) {
    const body = rest.slice(3);
    const colon = body.indexOf(':');
    if (colon <= 0) return null;
    const publicId = body.slice(0, colon);
    const keyPart = body.slice(colon + 1);
    const identity = parsePublicId(publicId);
    if (!identity) return null;
    const receiveKey = decodeSignedReceiveKey(keyPart);
    if (!receiveKey || !verifyReceiveKey(identity, receiveKey)) return null;
    return { identity, receiveKey };
  }

  const identity = parsePublicId(rest);
  return identity ? { identity, receiveKey: null } : null;
}

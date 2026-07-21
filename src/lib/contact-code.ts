/**
 * Contact introduction codes (QR / paste).
 *
 * v1: protestchat:<publicId>
 * v2: protestchat:v2:<publicId>:<prekeyBundle>
 *
 * v2 carries a signed prekey (SPK). One-time prekeys are deliberately omitted:
 * a QR can be scanned by many people, and consume-on-open OTKs would silently
 * drop every sealer after the first. First messages seal to the SPK; exclusive
 * OTKs arrive in-band on the first exchange.
 */

import type { PublicIdentity } from './crypto-core';
import { parsePublicId, verifyReceiveKey } from './crypto-core';
import type { PrekeyBundle } from './prekeys';
import { decodeBundle, encodeBundle } from './prekeys';

export const CONTACT_CODE_PREFIX = 'protestchat:';

export type ContactCode = {
  identity: PublicIdentity;
  /** Present when the code was v2 and the SPK signature verified. */
  bundle: PrekeyBundle | null;
};

/** Build a v2 code when we have a prekey bundle; otherwise v1. */
export function encodeContactCode(publicId: string, bundle?: PrekeyBundle | null): string {
  if (bundle) {
    return `${CONTACT_CODE_PREFIX}v2:${publicId}:${encodeBundle(bundle)}`;
  }
  return `${CONTACT_CODE_PREFIX}${publicId}`;
}

/**
 * Parse a pasted/scanned code. Invalid prekey signatures are rejected
 * entirely — better to fail introduction than store attacker-chosen keys.
 */
export function decodeContactCode(raw: string): ContactCode | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(CONTACT_CODE_PREFIX)) {
    const identity = parsePublicId(trimmed);
    return identity ? { identity, bundle: null } : null;
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
    const bundle = decodeBundle(keyPart);
    if (!bundle || !verifyReceiveKey(identity, bundle.signed, bundle.oneTimePublics)) return null;
    return { identity, bundle };
  }

  const identity = parsePublicId(rest);
  return identity ? { identity, bundle: null } : null;
}

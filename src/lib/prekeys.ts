/**
 * Per-message forward secrecy without a key server.
 *
 * Model (X3DH-shaped, mesh-adapted):
 *   - Signed prekey (SPK): medium-term fallback, rotated ~hourly, wiped after 6h.
 *   - One-time prekeys (OTK): sealed-to once; secret deleted the moment we open
 *     a message under it. That delete is per-message FS.
 *   - Distribution: QR intro carries **SPK only**; OTKs arrive in-band inside
 *     sealed direct/group/receipt bodies, issued per peer. A QR is inherently
 *     multi-scan — advertising OTKs there caused silent loss when two people
 *     sealed to the same intro key. SPK delivers; exclusive OTKs follow.
 *
 * OTKs are issued per peer. Re-advertising the same OTK to two peers would let
 * the second sealer's ciphertext become unopenable after the first is consumed
 * — so issuance is tracked.
 */

import { concat, fromBase64, toBase64 } from './bytes';
import type { Identity, PublicIdentity, ReceiveKey, SignedReceiveKey } from './crypto-core';
import {
  RECEIVE_KEY_RETENTION_MS,
  RECEIVE_KEY_ROTATION_MS,
  generateReceiveKey,
  signReceiveKey,
  verifyReceiveKey,
} from './crypto-core';

const X_LEN = 32;

/**
 * QR intros carry SPK only (`0` OTKs). Kept as a named constant so callers and
 * tests document the policy; raising it would reintroduce multi-scan silent loss.
 */
export const QR_OTK_COUNT = 0;
/** Fresh OTKs attached to each outbound sealed peer message. */
export const REPLENISH_OTK_COUNT = 8;
/** Keep at least this many unissued OTKs ready to assign. */
export const OTK_POOL_FLOOR = 8;
/**
 * Hard ceiling on retained OTK secrets. Bounds trial-decrypt cost: every sealed
 * envelope on the air is tried against every secret we hold, on a phone battery.
 */
export const OTK_POOL_CEILING = 24;
/**
 * Max agreement secrets `open()` will walk (OTK + SPK). Newest OTKs first.
 * Long-term identity is always tried after this list.
 */
export const OPEN_SECRET_CAP = 28;

export type PrekeyBundle = {
  signed: SignedReceiveKey;
  /** One-time publics the peer may seal to (each once). */
  oneTimePublics: Uint8Array[];
};

/** Wire form inside MessageBody (base64 fields). */
export type PrekeyUpdateWire = {
  spk: string;
  otks: string[];
};

type LocalOtk = ReceiveKey & {
  /** Peer publicId, 'qr', or null if not yet issued. */
  issuedTo: string | null;
};

/**
 * Our secrets: SPK ring + OTK pool.
 */
export class LocalPrekeys {
  private spk: ReceiveKey[] = [];
  private otks = new Map<string, LocalOtk>();

  load(spk: ReceiveKey[], otks: LocalOtk[]): void {
    this.spk = spk
      .map(cloneKey)
      .sort((a, b) => b.createdAt - a.createdAt);
    this.otks.clear();
    for (const o of otks) {
      this.otks.set(toBase64(o.public), {
        ...cloneKey(o),
        issuedTo: o.issuedTo,
      });
    }
  }

  snapshot(): { spk: ReceiveKey[]; otks: LocalOtk[] } {
    return {
      spk: this.spk.map(cloneKey),
      otks: [...this.otks.values()].map((o) => ({
        ...cloneKey(o),
        issuedTo: o.issuedTo,
      })),
    };
  }

  /**
   * Secrets for trial decryption: newest OTKs first, then SPKs, capped so a
   * full pool cannot turn every overheard envelope into dozens of X25519 ops.
   */
  secretsForOpen(): Uint8Array[] {
    const otks = [...this.otks.values()].sort((a, b) => b.createdAt - a.createdAt);
    const secrets = [...otks.map((o) => o.secret), ...this.spk.map((k) => k.secret)];
    return secrets.slice(0, OPEN_SECRET_CAP);
  }

  currentSpk(): ReceiveKey | null {
    return this.spk[0] ?? null;
  }

  ensureReady(now = Date.now()): void {
    this.sweep(now);
    if (this.spk.length === 0 || now - this.spk[0].createdAt >= RECEIVE_KEY_ROTATION_MS) {
      this.spk.unshift(generateReceiveKey(now));
    }
    this.fillPool();
  }

  sweep(now = Date.now()): number {
    const beforeSpk = this.spk.length;
    this.spk = this.spk.filter((k) => now - k.createdAt < RECEIVE_KEY_RETENTION_MS);
    let wiped = beforeSpk - this.spk.length;

    for (const [id, o] of [...this.otks]) {
      if (now - o.createdAt >= RECEIVE_KEY_RETENTION_MS) {
        this.otks.delete(id);
        wiped++;
      }
    }

    if (this.spk.length === 0) this.spk.unshift(generateReceiveKey(now));
    this.fillPool();
    return wiped;
  }

  /**
   * Delete the OTK secret that matched `agreementPublic`, if any.
   * Returns true when an OTK was consumed (per-message FS step).
   */
  consumeOtk(agreementPublic: Uint8Array): boolean {
    const id = toBase64(agreementPublic);
    if (!this.otks.has(id)) return false;
    this.otks.delete(id);
    this.fillPool();
    return true;
  }

  /**
   * QR / first-intro bundle: signed SPK only.
   * OTKs are never put on a QR — a plaque can be scanned by many people, and
   * consume-on-open would make all but the first sealer's message undeliverable
   * with no error. First post-scan seals use the SPK; in-band replenishment
   * then hands each peer exclusive OTKs.
   */
  bundleForQr(owner: Identity, _count = QR_OTK_COUNT): PrekeyBundle {
    this.ensureReady();
    const oneTimePublics: Uint8Array[] = [];
    const signed = signReceiveKey(owner, this.spk[0]!, oneTimePublics);
    return { signed, oneTimePublics };
  }

  /** In-band replenishment dedicated to one peer. */
  updateForPeer(owner: Identity, peerPublicId: string, count = REPLENISH_OTK_COUNT): PrekeyBundle {
    this.ensureReady();
    const oneTimePublics = this.issueOtks(peerPublicId, count);
    // Sign AFTER issuing so the signature binds this exact OTK list (#48).
    const signed = signReceiveKey(owner, this.spk[0]!, oneTimePublics);
    return { signed, oneTimePublics };
  }

  toWire(bundle: PrekeyBundle): PrekeyUpdateWire {
    return {
      spk: encodeSignedSpk(bundle.signed),
      otks: bundle.oneTimePublics.map((p) => toBase64(p)),
    };
  }

  private issueOtks(issuedTo: string, count: number): Uint8Array[] {
    this.fillPool();
    const out: Uint8Array[] = [];

    // Re-share OTKs already issued to this peer that still exist (not consumed).
    for (const o of this.otks.values()) {
      if (out.length >= count) break;
      if (o.issuedTo === issuedTo) out.push(Uint8Array.from(o.public));
    }

    for (const o of this.otks.values()) {
      if (out.length >= count) break;
      if (o.issuedTo === null) {
        o.issuedTo = issuedTo;
        out.push(Uint8Array.from(o.public));
      }
    }

    while (out.length < count && this.otks.size < OTK_POOL_CEILING) {
      const k = generateReceiveKey();
      const row: LocalOtk = { ...k, issuedTo };
      this.otks.set(toBase64(k.public), row);
      out.push(Uint8Array.from(k.public));
    }

    return out;
  }

  private fillPool(): void {
    let unissued = 0;
    for (const o of this.otks.values()) if (o.issuedTo === null) unissued++;
    while (unissued < OTK_POOL_FLOOR && this.otks.size < OTK_POOL_CEILING) {
      const k = generateReceiveKey();
      this.otks.set(toBase64(k.public), { ...k, issuedTo: null });
      unissued++;
    }
  }
}

/**
 * Peers' published agreement keys we seal to.
 */
export class PeerPrekeyBook {
  private peers = new Map<
    string,
    { spk: SignedReceiveKey | null; otks: Uint8Array[] }
  >();

  clear(): void {
    this.peers.clear();
  }

  load(
    entries: {
      publicId: string;
      spk: SignedReceiveKey | null;
      otks: Uint8Array[];
    }[],
  ): void {
    this.peers.clear();
    for (const e of entries) {
      this.peers.set(e.publicId, {
        spk: e.spk,
        otks: e.otks.map((p) => Uint8Array.from(p)),
      });
    }
  }

  snapshot(): {
    publicId: string;
    spk: SignedReceiveKey | null;
    otks: Uint8Array[];
  }[] {
    return [...this.peers.entries()].map(([publicId, v]) => ({
      publicId,
      spk: v.spk,
      otks: v.otks.map((p) => Uint8Array.from(p)),
    }));
  }

  /**
   * Merge a verified bundle from `owner`. The signature must bind the SPK and
   * the exact OTK list — substituted OTKs fail verification (#48).
   */
  absorb(owner: PublicIdentity, bundle: PrekeyBundle): boolean {
    if (!verifyReceiveKey(owner, bundle.signed, bundle.oneTimePublics)) return false;
    let row = this.peers.get(owner.publicId);
    if (!row) {
      row = { spk: null, otks: [] };
      this.peers.set(owner.publicId, row);
    }
    // Prefer newer SPK by createdAt.
    if (!row.spk || bundle.signed.createdAt >= row.spk.createdAt) {
      row.spk = {
        public: Uint8Array.from(bundle.signed.public),
        createdAt: bundle.signed.createdAt,
        signature: Uint8Array.from(bundle.signed.signature),
      };
    }
    const known = new Set(row.otks.map((p) => toBase64(p)));
    for (const p of bundle.oneTimePublics) {
      if (p.length !== X_LEN) continue;
      const id = toBase64(p);
      if (known.has(id)) continue;
      known.add(id);
      row.otks.push(Uint8Array.from(p));
    }
    return true;
  }

  absorbWire(owner: PublicIdentity, wire: PrekeyUpdateWire): boolean {
    const bundle = bundleFromWire(wire);
    if (!bundle) return false;
    return this.absorb(owner, bundle);
  }

  /**
   * Pick a seal target: OTK (consumed from our book) > SPK > long-term.
   * Consuming the OTK public here is load-bearing — two seals must not reuse it.
   */
  takeAgreementPublic(recipient: PublicIdentity): {
    public: Uint8Array;
    kind: 'otk' | 'spk' | 'long-term';
  } {
    const row = this.peers.get(recipient.publicId);
    if (row && row.otks.length > 0) {
      const publicKey = row.otks.shift()!;
      return { public: publicKey, kind: 'otk' };
    }
    if (row?.spk) {
      return { public: Uint8Array.from(row.spk.public), kind: 'spk' };
    }
    return { public: recipient.xPublic, kind: 'long-term' };
  }

  otkCount(publicId: string): number {
    return this.peers.get(publicId)?.otks.length ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function encodeSignedSpk(signed: SignedReceiveKey): string {
  const ts = new Uint8Array(8);
  const view = new DataView(ts.buffer);
  view.setUint32(0, Math.floor(signed.createdAt / 0x100000000));
  view.setUint32(4, signed.createdAt >>> 0);
  return toBase64(concat(signed.public, ts, signed.signature));
}

function decodeSignedSpk(encoded: string): SignedReceiveKey | null {
  try {
    const raw = fromBase64(encoded);
    if (raw.length !== X_LEN + 8 + 64) return null;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const createdAt = view.getUint32(X_LEN) * 0x100000000 + view.getUint32(X_LEN + 4);
    return {
      public: raw.slice(0, X_LEN),
      createdAt,
      signature: raw.slice(X_LEN + 8),
    };
  } catch {
    return null;
  }
}

function signedSpkBytes(signed: SignedReceiveKey): Uint8Array {
  const ts = new Uint8Array(8);
  const view = new DataView(ts.buffer);
  view.setUint32(0, Math.floor(signed.createdAt / 0x100000000));
  view.setUint32(4, signed.createdAt >>> 0);
  return concat(signed.public, ts, signed.signature);
}

/** Binary bundle for QR: ver(1) || spk(32+8+64) || n(u16) || otk*n. */
export function encodeBundle(bundle: PrekeyBundle): string {
  const spk = signedSpkBytes(bundle.signed);
  const n = bundle.oneTimePublics.length;
  const out = new Uint8Array(1 + spk.length + 2 + n * X_LEN);
  out[0] = 1;
  out.set(spk, 1);
  out[1 + spk.length] = (n >> 8) & 0xff;
  out[1 + spk.length + 1] = n & 0xff;
  let o = 1 + spk.length + 2;
  for (const p of bundle.oneTimePublics) {
    if (p.length !== X_LEN) throw new Error('otk public must be 32 bytes');
    out.set(p, o);
    o += X_LEN;
  }
  return toBase64(out);
}

export function decodeBundle(encoded: string): PrekeyBundle | null {
  try {
    const raw = fromBase64(encoded);
    const spkLen = X_LEN + 8 + 64;
    if (raw.length < 1 + spkLen + 2) return null;
    if (raw[0] !== 1) return null;
    const signed = decodeSignedSpk(toBase64(raw.subarray(1, 1 + spkLen)));
    if (!signed) return null;
    const n = (raw[1 + spkLen] << 8) | raw[1 + spkLen + 1];
    if (n < 0 || n > 64) return null;
    const need = 1 + spkLen + 2 + n * X_LEN;
    if (raw.length !== need) return null;
    const oneTimePublics: Uint8Array[] = [];
    let o = 1 + spkLen + 2;
    for (let i = 0; i < n; i++) {
      oneTimePublics.push(raw.slice(o, o + X_LEN));
      o += X_LEN;
    }
    return { signed, oneTimePublics };
  } catch {
    return null;
  }
}

export function bundleFromWire(wire: PrekeyUpdateWire): PrekeyBundle | null {
  if (!wire || typeof wire.spk !== 'string' || !Array.isArray(wire.otks)) return null;
  const signed = decodeSignedSpk(wire.spk);
  if (!signed) return null;
  const oneTimePublics: Uint8Array[] = [];
  for (const s of wire.otks) {
    if (typeof s !== 'string') return null;
    try {
      const p = fromBase64(s);
      if (p.length !== X_LEN) return null;
      oneTimePublics.push(p);
    } catch {
      return null;
    }
  }
  return { signed, oneTimePublics };
}

export function isForwardSecretKind(kind: 'otk' | 'spk' | 'long-term'): boolean {
  return kind === 'otk' || kind === 'spk';
}

export type PersistedOtk = LocalOtk;

function cloneKey(k: ReceiveKey): ReceiveKey {
  return {
    secret: Uint8Array.from(k.secret),
    public: Uint8Array.from(k.public),
    createdAt: k.createdAt,
  };
}

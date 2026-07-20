/**
 * Forward-secrecy properties for signed receive keys.
 *
 * The claim under test: after a recipient deletes a receive-key secret,
 * compromise of their long-term identity seed must not open messages that
 * were sealed to that receive key.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { equalBytes, toUtf8 } from '../bytes';
import {
  RECEIVE_KEY_RETENTION_MS,
  RECEIVE_KEY_ROTATION_MS,
  ReceiveKeyRing,
  decodeSignedReceiveKey,
  encodeSignedReceiveKey,
  generateReceiveKey,
  identityFromSeed,
  isForwardSecretAgreement,
  open,
  seal,
  signReceiveKey,
  verifyReceiveKey,
} from '../crypto-core';
import { decodeContactCode, encodeContactCode } from '../contact-code';

const alice = identityFromSeed(new Uint8Array(32).fill(1));
const bob = identityFromSeed(new Uint8Array(32).fill(2));
const eve = identityFromSeed(new Uint8Array(32).fill(3));

const pub = (id: typeof alice) => ({
  edPublic: id.edPublic,
  xPublic: id.xPublic,
  publicId: id.publicId,
});

describe('signed receive keys', () => {
  it('round-trips encoding and verifies under the owner', () => {
    const key = generateReceiveKey(1_700_000_000_000);
    const signed = signReceiveKey(bob, key);
    assert.equal(verifyReceiveKey(pub(bob), signed), true);
    const decoded = decodeSignedReceiveKey(encodeSignedReceiveKey(signed));
    assert.ok(decoded);
    assert.deepEqual([...decoded.public], [...signed.public]);
    assert.equal(decoded.createdAt, signed.createdAt);
    assert.equal(verifyReceiveKey(pub(bob), decoded), true);
  });

  it('rejects a receive key signed by someone else', () => {
    const key = generateReceiveKey();
    const forged = signReceiveKey(eve, key);
    assert.equal(verifyReceiveKey(pub(bob), forged), false);
  });

  it('rejects truncated or garbage encodings', () => {
    assert.equal(decodeSignedReceiveKey(''), null);
    assert.equal(decodeSignedReceiveKey('AAAA'), null);
    assert.equal(decodeSignedReceiveKey(encodeSignedReceiveKey(signReceiveKey(bob, generateReceiveKey())).slice(0, 10)), null);
  });
});

describe('contact code v2', () => {
  it('embeds a verified receive key', () => {
    const signed = signReceiveKey(bob, generateReceiveKey(42));
    const code = encodeContactCode(bob.publicId, signed);
    const parsed = decodeContactCode(code);
    assert.ok(parsed);
    assert.equal(parsed.identity.publicId, bob.publicId);
    assert.ok(parsed.receiveKey);
    assert.deepEqual([...parsed.receiveKey.public], [...signed.public]);
  });

  it('still accepts legacy v1 codes without a receive key', () => {
    const parsed = decodeContactCode(`protestchat:${bob.publicId}`);
    assert.ok(parsed);
    assert.equal(parsed.identity.publicId, bob.publicId);
    assert.equal(parsed.receiveKey, null);
  });

  it('rejects v2 codes with a bad signature rather than accepting the identity alone', () => {
    const signed = signReceiveKey(bob, generateReceiveKey());
    const tampered = {
      ...signed,
      signature: Uint8Array.from(signed.signature.map((b, i) => (i === 0 ? b ^ 0xff : b))),
    };
    const code = encodeContactCode(bob.publicId, tampered);
    assert.equal(decodeContactCode(code), null);
  });
});

describe('seal to receive key', () => {
  it('delivers when the recipient still holds the secret', () => {
    const rk = generateReceiveKey();
    const sealed = seal(alice, pub(bob), toUtf8('meet at gate 3'), rk.public);
    const opened = open(bob, sealed, [rk.secret]);
    assert.ok(opened);
    assert.equal(Buffer.from(opened.body).toString('utf8'), 'meet at gate 3');
    assert.ok(opened.agreementPublic);
    assert.deepEqual([...opened.agreementPublic], [...rk.public]);
    assert.equal(isForwardSecretAgreement(pub(bob), opened.agreementPublic!), true);
  });

  it('is opaque to a third party without the receive secret', () => {
    const rk = generateReceiveKey();
    const sealed = seal(alice, pub(bob), toUtf8('secret'), rk.public);
    assert.equal(open(eve, sealed, []), null);
    assert.equal(open(eve, sealed, [generateReceiveKey().secret]), null);
    // Possession of the receive secret *is* decryption capability — that is
    // why wiping it creates FS. Eve with rk.secret can open; that is expected.
    assert.ok(open(eve, sealed, [rk.secret]));
  });

  it('FALLBACK: long-term seal still works with no receive secrets', () => {
    const sealed = seal(alice, pub(bob), toUtf8('legacy'));
    const opened = open(bob, sealed);
    assert.ok(opened);
    assert.equal(isForwardSecretAgreement(pub(bob), opened.agreementPublic!), false);
  });

  it('THE FS CLAIM: long-term identity compromise cannot open a sealed-to-receive-key message after the secret is gone', () => {
    const rk = generateReceiveKey();
    const sealed = seal(alice, pub(bob), toUtf8('burn after reading'), rk.public);

    // Recipient still has the secret → opens.
    assert.ok(open(bob, sealed, [rk.secret]));

    // Adversary steals Bob's long-term seed (same identity) but NOT the wiped
    // receive-key secret. This is the seizure-after-rotation case.
    const bobAfterCompromise = identityFromSeed(new Uint8Array(32).fill(2));
    assert.equal(
      open(bobAfterCompromise, sealed, []),
      null,
      'long-term secret alone must not open FS-sealed mail',
    );
  });

  it('cannot open with the wrong receive secret even if long-term would have worked for a legacy seal', () => {
    const rk = generateReceiveKey();
    const other = generateReceiveKey();
    const sealed = seal(alice, pub(bob), toUtf8('hi'), rk.public);
    assert.equal(open(bob, sealed, [other.secret]), null);
  });
});

describe('ReceiveKeyRing', () => {
  it('rotates when the current key ages past the rotation interval', () => {
    const ring = new ReceiveKeyRing();
    const t0 = 1_000_000;
    ring.ensureFresh(t0);
    const first = ring.current()!.public;
    assert.equal(ring.ensureFresh(t0 + 1_000), false);
    assert.deepEqual([...ring.current()!.public], [...first]);
    assert.equal(ring.ensureFresh(t0 + RECEIVE_KEY_ROTATION_MS), true);
    assert.equal(equalBytes(ring.current()!.public, first), false);
    // Old secret retained for open.
    assert.equal(ring.secrets().length, 2);
  });

  it('wipes secrets past retention — this is the FS ratchet step', () => {
    const ring = new ReceiveKeyRing();
    const t0 = 1_000_000;
    ring.ensureFresh(t0);
    const old = ring.current()!;
    ring.ensureFresh(t0 + RECEIVE_KEY_ROTATION_MS);
    assert.equal(ring.secrets().length, 2);

    const wiped = ring.sweep(t0 + RECEIVE_KEY_ROTATION_MS + RECEIVE_KEY_RETENTION_MS);
    assert.ok(wiped >= 1);
    assert.equal(
      ring.secrets().some((s) => equalBytes(s, old.secret)),
      false,
      'retired secret must be gone',
    );
  });

  it('never leaves the ring empty after a sweep', () => {
    const ring = new ReceiveKeyRing([generateReceiveKey(1)]);
    ring.sweep(1 + RECEIVE_KEY_RETENTION_MS + 1);
    assert.ok(ring.current());
    assert.equal(ring.secrets().length, 1);
  });
});

describe('stress / edge cases', () => {
  it('opens the correct message among many receive secrets (trial decrypt)', () => {
    const secrets: Uint8Array[] = [];
    let targetPublic: Uint8Array | null = null;
    let targetSecret: Uint8Array | null = null;
    for (let i = 0; i < 64; i++) {
      const k = generateReceiveKey(i);
      secrets.push(k.secret);
      if (i === 37) {
        targetPublic = k.public;
        targetSecret = k.secret;
      }
    }
    const sealed = seal(alice, pub(bob), toUtf8(`needle-${37}`), targetPublic!);
    const opened = open(bob, sealed, secrets);
    assert.ok(opened);
    assert.equal(Buffer.from(opened.body).toString('utf8'), 'needle-37');
    assert.ok(equalBytes(opened.agreementPublic!, targetPublic!));
    void targetSecret;
  });

  it('survives sealing many messages to a rotating ring without cross-talk', () => {
    const ring = new ReceiveKeyRing();
    let now = 1_000_000;
    const sealed: { ct: Uint8Array; text: string }[] = [];

    for (let i = 0; i < 20; i++) {
      ring.ensureFresh(now);
      const text = `msg-${i}`;
      sealed.push({
        ct: seal(alice, pub(bob), toUtf8(text), ring.current()!.public),
        text,
      });
      now += RECEIVE_KEY_ROTATION_MS / 4;
    }

    // Same timeline on the recipient: every ciphertext must still open under
    // the retained ring (no sweep — within the 6h retention window).
    for (const item of sealed) {
      const opened = open(bob, item.ct, ring.secrets());
      assert.ok(opened, `failed to open ${item.text}`);
      assert.equal(Buffer.from(opened.body).toString('utf8'), item.text);
    }
  });

  it('after full retention elapses, old ciphertexts are dead even with identity seed', () => {
    const ring = new ReceiveKeyRing();
    const t0 = 5_000_000;
    ring.ensureFresh(t0);
    const sealed = seal(alice, pub(bob), toUtf8('old'), ring.current()!.public);

    ring.ensureFresh(t0 + RECEIVE_KEY_ROTATION_MS);
    ring.sweep(t0 + RECEIVE_KEY_RETENTION_MS + 1);

    assert.equal(open(bob, sealed, ring.secrets()), null);
    assert.equal(open(bob, sealed, []), null);
  });

  it('high-volume seal/open under receive keys does not throw or mis-deliver', () => {
    const rk = generateReceiveKey();
    for (let i = 0; i < 200; i++) {
      const sealed = seal(alice, pub(bob), toUtf8(`bulk-${i}`), rk.public);
      const opened = open(bob, sealed, [rk.secret]);
      assert.equal(Buffer.from(opened!.body).toString('utf8'), `bulk-${i}`);
    }
  });

  it('channel and direct layouts remain distinguishable by trial decryption alone', async () => {
    const { deriveChannelKey, sealToKey, openWithKey } = await import('../crypto-core');
    const key = deriveChannelKey('gate4', 'pw pw pw');
    const rk = generateReceiveKey();
    const direct = seal(alice, pub(bob), toUtf8('private'), rk.public);
    const channel = sealToKey(alice, key, toUtf8('channel'));
    assert.equal(openWithKey(key, direct), null);
    assert.equal(open(bob, channel, [rk.secret]), null);
  });
});

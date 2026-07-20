/**
 * Per-message forward secrecy: one-time prekeys + consume-on-open.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toUtf8 } from '../bytes';
import { decodeContactCode, encodeContactCode } from '../contact-code';
import {
  identityFromSeed,
  isForwardSecretAgreement,
  open,
  seal,
  verifyReceiveKey,
} from '../crypto-core';
import {
  LocalPrekeys,
  PeerPrekeyBook,
  QR_OTK_COUNT,
  decodeBundle,
  encodeBundle,
} from '../prekeys';

const alice = identityFromSeed(new Uint8Array(32).fill(1));
const bob = identityFromSeed(new Uint8Array(32).fill(2));
const eve = identityFromSeed(new Uint8Array(32).fill(3));

const pub = (id: typeof alice) => ({
  edPublic: id.edPublic,
  xPublic: id.xPublic,
  publicId: id.publicId,
});

describe('prekey bundles', () => {
  it('QR bundle verifies and round-trips', () => {
    const local = new LocalPrekeys();
    local.ensureReady();
    const bundle = local.bundleForQr(bob, QR_OTK_COUNT);
    assert.equal(verifyReceiveKey(pub(bob), bundle.signed), true);
    assert.equal(bundle.oneTimePublics.length, QR_OTK_COUNT);
    const decoded = decodeBundle(encodeBundle(bundle));
    assert.ok(decoded);
    assert.equal(decoded.oneTimePublics.length, QR_OTK_COUNT);
    assert.equal(verifyReceiveKey(pub(bob), decoded.signed), true);
  });

  it('contact code v2 embeds a full bundle; v1 still works', () => {
    const local = new LocalPrekeys();
    const bundle = local.bundleForQr(bob);
    const v2 = decodeContactCode(encodeContactCode(bob.publicId, bundle));
    assert.ok(v2?.bundle);
    assert.equal(v2.bundle.oneTimePublics.length, QR_OTK_COUNT);

    const v1 = decodeContactCode(`protestchat:${bob.publicId}`);
    assert.ok(v1);
    assert.equal(v1.bundle, null);
  });

  it('rejects a bundle whose SPK is signed by the wrong identity', () => {
    const local = new LocalPrekeys();
    const bundle = local.bundleForQr(eve);
    const code = encodeContactCode(bob.publicId, bundle);
    assert.equal(decodeContactCode(code), null);
  });
});

describe('per-message FS via OTK', () => {
  it('seals to an OTK, opens, consumes — long-term seed cannot reopen', () => {
    const bobLocal = new LocalPrekeys();
    bobLocal.ensureReady();
    const bundle = bobLocal.bundleForQr(bob);

    const aliceBook = new PeerPrekeyBook();
    assert.equal(aliceBook.absorb(pub(bob), bundle), true);

    const { public: agreement, kind } = aliceBook.takeAgreementPublic(pub(bob));
    assert.equal(kind, 'otk');

    const sealed = seal(alice, pub(bob), toUtf8('burn after reading'), agreement);
    const opened = open(bob, sealed, bobLocal.secretsForOpen());
    assert.ok(opened);
    assert.equal(Buffer.from(opened.body).toString('utf8'), 'burn after reading');
    assert.equal(isForwardSecretAgreement(pub(bob), opened.agreementPublic!), true);

    assert.equal(bobLocal.consumeOtk(opened.agreementPublic!), true);

    // Identity compromise after OTK wipe.
    const bobCompromised = identityFromSeed(new Uint8Array(32).fill(2));
    assert.equal(
      open(bobCompromised, sealed, bobLocal.secretsForOpen()),
      null,
      'consumed OTK + long-term seed must not reopen',
    );
    assert.equal(open(bobCompromised, sealed, []), null);
  });

  it('does not reuse an OTK public for two seals', () => {
    const bobLocal = new LocalPrekeys();
    const bundle = bobLocal.bundleForQr(bob, 2);
    const book = new PeerPrekeyBook();
    book.absorb(pub(bob), bundle);

    const a = book.takeAgreementPublic(pub(bob));
    const b = book.takeAgreementPublic(pub(bob));
    assert.equal(a.kind, 'otk');
    assert.equal(b.kind, 'otk');
    assert.notDeepEqual([...a.public], [...b.public]);
  });

  it('falls back to SPK then long-term when OTKs are exhausted', () => {
    const bobLocal = new LocalPrekeys();
    const bundle = bobLocal.bundleForQr(bob, 1);
    const book = new PeerPrekeyBook();
    book.absorb(pub(bob), bundle);

    assert.equal(book.takeAgreementPublic(pub(bob)).kind, 'otk');
    assert.equal(book.takeAgreementPublic(pub(bob)).kind, 'spk');

    const empty = new PeerPrekeyBook();
    assert.equal(empty.takeAgreementPublic(pub(bob)).kind, 'long-term');
  });

  it('in-band replenishment restores OTK sealing after exhaustion', () => {
    const bobLocal = new LocalPrekeys();
    const intro = bobLocal.bundleForQr(bob, 1);
    const aliceBook = new PeerPrekeyBook();
    aliceBook.absorb(pub(bob), intro);
    aliceBook.takeAgreementPublic(pub(bob)); // exhaust the one OTK
    assert.equal(aliceBook.takeAgreementPublic(pub(bob)).kind, 'spk');

    const replenish = bobLocal.updateForPeer(bob, alice.publicId, 4);
    assert.equal(aliceBook.absorb(pub(bob), replenish), true);
    assert.equal(aliceBook.takeAgreementPublic(pub(bob)).kind, 'otk');
  });

  it('OTKs issued to Alice are not the same set issued to Carol', () => {
    const bobLocal = new LocalPrekeys();
    bobLocal.ensureReady();
    const forAlice = bobLocal.updateForPeer(bob, alice.publicId, 4);
    const forCarol = bobLocal.updateForPeer(bob, eve.publicId, 4);
    const aliceSet = new Set(forAlice.oneTimePublics.map((p) => Buffer.from(p).toString('hex')));
    for (const p of forCarol.oneTimePublics) {
      assert.equal(aliceSet.has(Buffer.from(p).toString('hex')), false);
    }
  });
});

describe('stress', () => {
  it('100 sequential OTK messages each die after consume', () => {
    const bobLocal = new LocalPrekeys();
    bobLocal.ensureReady();
    const aliceBook = new PeerPrekeyBook();
    aliceBook.absorb(pub(bob), bobLocal.bundleForQr(bob, 24));

    for (let i = 0; i < 100; i++) {
      if (aliceBook.otkCount(bob.publicId) === 0) {
        aliceBook.absorb(pub(bob), bobLocal.updateForPeer(bob, alice.publicId, 16));
      }
      const { public: agreement, kind } = aliceBook.takeAgreementPublic(pub(bob));
      assert.equal(kind, 'otk', `message ${i} should use OTK`);
      const sealed = seal(alice, pub(bob), toUtf8(`m-${i}`), agreement);
      const opened = open(bob, sealed, bobLocal.secretsForOpen());
      assert.ok(opened);
      bobLocal.consumeOtk(opened.agreementPublic!);
      assert.equal(open(bob, sealed, bobLocal.secretsForOpen()), null);
      assert.equal(open(bob, sealed, []), null);
    }
  });
});

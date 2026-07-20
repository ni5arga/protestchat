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
  OPEN_SECRET_CAP,
  OTK_POOL_CEILING,
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
  it('QR bundle is SPK-only (no OTKs) and round-trips', () => {
    const local = new LocalPrekeys();
    local.ensureReady();
    const bundle = local.bundleForQr(bob);
    assert.equal(QR_OTK_COUNT, 0);
    assert.equal(verifyReceiveKey(pub(bob), bundle.signed), true);
    assert.equal(bundle.oneTimePublics.length, 0);
    const decoded = decodeBundle(encodeBundle(bundle));
    assert.ok(decoded);
    assert.equal(decoded.oneTimePublics.length, 0);
    assert.equal(verifyReceiveKey(pub(bob), decoded.signed), true);
  });

  it('contact code v2 embeds SPK; v1 still works', () => {
    const local = new LocalPrekeys();
    const bundle = local.bundleForQr(bob);
    const v2 = decodeContactCode(encodeContactCode(bob.publicId, bundle));
    assert.ok(v2?.bundle);
    assert.equal(v2.bundle.oneTimePublics.length, 0);
    assert.equal(verifyReceiveKey(v2.identity, v2.bundle.signed), true);

    // SPK-only keeps the plaque scannable in a crowd (~104 bytes of key material).
    const code = encodeContactCode(bob.publicId, bundle);
    assert.ok(code.length < 400, `QR payload too large: ${code.length}`);

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
    const bundle = bobLocal.updateForPeer(bob, alice.publicId, 4);

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

  it('QR intro seals to SPK so two scanners both deliver', () => {
    const bobLocal = new LocalPrekeys();
    const qr = bobLocal.bundleForQr(bob);
    assert.equal(qr.oneTimePublics.length, 0);

    const aliceBook = new PeerPrekeyBook();
    const eveBook = new PeerPrekeyBook();
    assert.equal(aliceBook.absorb(pub(bob), qr), true);
    assert.equal(eveBook.absorb(pub(bob), qr), true);

    const a = aliceBook.takeAgreementPublic(pub(bob));
    const e = eveBook.takeAgreementPublic(pub(bob));
    assert.equal(a.kind, 'spk');
    assert.equal(e.kind, 'spk');

    const sealedA = seal(alice, pub(bob), toUtf8('from-alice'), a.public);
    const sealedE = seal(eve, pub(bob), toUtf8('from-eve'), e.public);
    const secrets = bobLocal.secretsForOpen();
    assert.ok(open(bob, sealedA, secrets));
    assert.ok(open(bob, sealedE, secrets));
  });

  it('does not reuse an OTK public for two seals', () => {
    const bobLocal = new LocalPrekeys();
    const bundle = bobLocal.updateForPeer(bob, alice.publicId, 2);
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
    const bundle = bobLocal.updateForPeer(bob, alice.publicId, 1);
    const book = new PeerPrekeyBook();
    book.absorb(pub(bob), bundle);

    assert.equal(book.takeAgreementPublic(pub(bob)).kind, 'otk');
    assert.equal(book.takeAgreementPublic(pub(bob)).kind, 'spk');

    const empty = new PeerPrekeyBook();
    assert.equal(empty.takeAgreementPublic(pub(bob)).kind, 'long-term');
  });

  it('in-band replenishment restores OTK sealing after QR (SPK) intro', () => {
    const bobLocal = new LocalPrekeys();
    const intro = bobLocal.bundleForQr(bob);
    const aliceBook = new PeerPrekeyBook();
    aliceBook.absorb(pub(bob), intro);
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

  it('caps trial-open secrets and the OTK pool', () => {
    const local = new LocalPrekeys();
    local.ensureReady();
    // Mint well past the ceiling via per-peer issuance.
    for (let i = 0; i < 8; i++) {
      local.updateForPeer(bob, `peer-${i}`, 8);
    }
    assert.ok(local.snapshot().otks.length <= OTK_POOL_CEILING);
    assert.ok(local.secretsForOpen().length <= OPEN_SECRET_CAP);
  });
});

describe('trial-open cost', () => {
  it('documents worst-case open() cost with a full secret set', () => {
    const bobLocal = new LocalPrekeys();
    bobLocal.ensureReady();
    // Fill toward the ceiling with exclusive peer OTKs.
    bobLocal.updateForPeer(bob, alice.publicId, OTK_POOL_CEILING);
    const secrets = bobLocal.secretsForOpen();
    assert.ok(secrets.length >= 8);

    // Foreign mail: every secret must fail (the expensive / common path).
    const sealed = seal(alice, pub(eve), toUtf8('not for bob'), pub(eve).xPublic);
    const rounds = 200;
    const t0 = performance.now();
    for (let i = 0; i < rounds; i++) {
      assert.equal(open(bob, sealed, secrets), null);
    }
    const avgMs = (performance.now() - t0) / rounds;
    // Loose host-side sanity check only — phones differ; the real control is the
    // pool ceiling. Log the number for PR review / device comparison.
    assert.ok(avgMs < 200, `full-pool open looks accidentally quadratic: ${avgMs.toFixed(2)}ms`);
    console.log(
      `trial-open cost: ${secrets.length} secrets → ${avgMs.toFixed(2)}ms/envelope (host)`,
    );
  });
});

describe('stress', () => {
  it('100 sequential OTK messages each die after consume', () => {
    const bobLocal = new LocalPrekeys();
    bobLocal.ensureReady();
    const aliceBook = new PeerPrekeyBook();
    aliceBook.absorb(pub(bob), bobLocal.updateForPeer(bob, alice.publicId, 16));

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

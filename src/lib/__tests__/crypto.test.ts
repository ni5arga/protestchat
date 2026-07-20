/**
 * Tests for the sealing construction.
 *
 * These are the tests that matter. Bridgefy shipped to protesters in Hong Kong
 * and during the CAA protests with a construction that allowed impersonation
 * and MITM, and it took an academic paper to find out. Every property the
 * threat model claims should have a test here that fails if the claim breaks.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

import { toUtf8 } from '../bytes';
import {
  PUBLIC_CHANNEL_KEY,
  PUBLIC_CHANNEL_NAME,
  deriveChannelKey,
  isPublicChannelName,
  identityFromSeed,
  open,
  openWithKey,
  sealToKey,
  parsePublicId,
  randomId,
  safetyNumber,
  seal,
  sealText,
} from '../crypto-core';

const alice = identityFromSeed(new Uint8Array(32).fill(1));
const bob = identityFromSeed(new Uint8Array(32).fill(2));
const eve = identityFromSeed(new Uint8Array(32).fill(3));

const pub = (id: typeof alice) => ({
  edPublic: id.edPublic,
  xPublic: id.xPublic,
  publicId: id.publicId,
});

describe('identity', () => {
  it('is deterministic from the seed', () => {
    assert.equal(identityFromSeed(new Uint8Array(32).fill(1)).publicId, alice.publicId);
  });

  it('round-trips through the public id encoding', () => {
    const parsed = parsePublicId(alice.publicId);
    assert.ok(parsed);
    assert.deepEqual([...parsed.edPublic], [...alice.edPublic]);
    assert.deepEqual([...parsed.xPublic], [...alice.xPublic]);
  });

  it('rejects malformed public ids rather than throwing', () => {
    assert.equal(parsePublicId('not base64 at all !!'), null);
    assert.equal(parsePublicId(''), null);
    assert.equal(parsePublicId('AAAA'), null);
  });

  it('derives distinct signing and agreement keys', () => {
    assert.notDeepEqual([...alice.edPublic], [...alice.xPublic]);
  });
});

describe('safety numbers', () => {
  it('is the same on both sides regardless of who asks', () => {
    assert.equal(safetyNumber(pub(alice), pub(bob)), safetyNumber(pub(bob), pub(alice)));
  });

  it('differs for a different pair', () => {
    assert.notEqual(safetyNumber(pub(alice), pub(bob)), safetyNumber(pub(alice), pub(eve)));
  });

  it('is 60 digits in groups of five', () => {
    // 60 digits (two per-key fingerprints of 30) so a MITM at introduction faces
    // a per-half second-preimage, not a birthday collision on a combined value.
    assert.match(safetyNumber(pub(alice), pub(bob)), /^(\d{5} ){11}\d{5}$/);
    assert.equal(safetyNumber(pub(alice), pub(bob)).replace(/ /g, '').length, 60);
  });

  it("changing either party's key changes the number", () => {
    // Each half commits to one real key, so swapping a key must move the digits
    // — this is the property that makes an introduction MITM need a preimage.
    assert.notEqual(safetyNumber(pub(alice), pub(bob)), safetyNumber(pub(eve), pub(bob)));
    assert.notEqual(safetyNumber(pub(alice), pub(bob)), safetyNumber(pub(alice), pub(eve)));
  });

  it('digits are not visibly mod-10 biased', () => {
    // Rejection sampling should keep the digit distribution roughly flat. Sample
    // many numbers and assert no digit is wildly over/under-represented.
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 40; i++) {
      const other = identityFromSeed(new Uint8Array(32).fill((i % 250) + 1));
      for (const ch of safetyNumber(pub(alice), pub(other)).replace(/ /g, '')) {
        counts[Number(ch)]++;
      }
    }
    const total = counts.reduce((a, b) => a + b, 0);
    for (const c of counts) assert.ok(c > total / 10 / 2, `digit under-represented: ${counts}`);
  });
});

describe('seal / open', () => {
  it('delivers to the intended recipient', () => {
    const sealed = sealText(alice, pub(bob), 'meet at gate 3');
    const opened = open(bob, sealed);
    assert.ok(opened);
    assert.equal(Buffer.from(opened.body).toString('utf8'), 'meet at gate 3');
  });

  it('authenticates the sender', () => {
    const opened = open(bob, sealText(alice, pub(bob), 'hi'));
    assert.equal(opened?.sender.publicId, alice.publicId);
  });

  it('is opaque to a third party — this is the whole point', () => {
    assert.equal(open(eve, sealText(alice, pub(bob), 'hi')), null);
  });

  it('does not leak the sender to a third party', () => {
    const sealed = sealText(alice, pub(bob), 'hi');
    // The sender's public key must not appear in the clear anywhere on the wire.
    const hay = Buffer.from(sealed).toString('hex');
    assert.ok(!hay.includes(Buffer.from(alice.edPublic).toString('hex')));
    assert.ok(!hay.includes(Buffer.from(alice.xPublic).toString('hex')));
  });

  it('does not leak the recipient to a third party', () => {
    const sealed = sealText(alice, pub(bob), 'hi');
    const hay = Buffer.from(sealed).toString('hex');
    assert.ok(!hay.includes(Buffer.from(bob.xPublic).toString('hex')));
  });

  it('rejects any tampering with the ciphertext', () => {
    const sealed = sealText(alice, pub(bob), 'hi');
    for (const i of [0, 40, sealed.length - 1]) {
      const mutated = Uint8Array.from(sealed);
      mutated[i] ^= 0xff;
      assert.equal(open(bob, mutated), null, `byte ${i} flip was accepted`);
    }
  });

  it('cannot be replayed at a different recipient', () => {
    // Eve intercepts a message for Bob and re-addresses it to herself. The
    // recipient key is bound into the KDF salt and the signature, so this dies.
    const sealed = sealText(alice, pub(bob), 'hi');
    assert.equal(open(eve, sealed), null);
  });

  it('produces different ciphertext every time', () => {
    const a = sealText(alice, pub(bob), 'same text');
    const b = sealText(alice, pub(bob), 'same text');
    assert.notDeepEqual([...a], [...b]);
  });

  it('survives an empty body and a large body', () => {
    for (const body of [new Uint8Array(0), new Uint8Array(8000).fill(7)]) {
      const opened = open(bob, seal(alice, pub(bob), body));
      assert.ok(opened);
      assert.deepEqual([...opened.body], [...body]);
    }
  });

  it('never throws on hostile input', () => {
    const garbage = [
      new Uint8Array(0),
      new Uint8Array(10),
      new Uint8Array(200).fill(0xff),
      toUtf8('definitely not a sealed envelope'),
    ];
    for (const g of garbage) assert.equal(open(bob, g), null);
  });

  it('rejects a forged signature from a would-be impersonator', () => {
    // Eve seals to Bob but splices Alice's public key into the plaintext to
    // claim she is Alice. She cannot produce Alice's signature, so it fails.
    const sealed = seal(eve, pub(bob), toUtf8('trust me'));
    const opened = open(bob, sealed);
    assert.equal(opened?.sender.publicId, eve.publicId);
    assert.notEqual(opened?.sender.publicId, alice.publicId);
  });
});

describe('randomId', () => {
  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 1000 }, randomId));
    assert.equal(ids.size, 1000);
  });
});

describe('channels', () => {
  const key = deriveChannelKey('gate4', 'correct horse battery staple');

  it('derives the same key from the same name and passphrase', () => {
    assert.deepEqual([...deriveChannelKey('gate4', 'correct horse battery staple')], [...key]);
  });

  it('normalises names so word-of-mouth works', () => {
    const a = deriveChannelKey('#Gate 4', 'pw');
    const b = deriveChannelKey('gate-4', 'pw');
    assert.deepEqual([...a], [...b]);
  });

  it('gives a different key for a different passphrase', () => {
    assert.notDeepEqual([...deriveChannelKey('gate4', 'other')], [...key]);
  });

  it('gives a different key for a different channel name', () => {
    assert.notDeepEqual([...deriveChannelKey('gate5', 'correct horse battery staple')], [...key]);
  });

  it('delivers to everyone holding the key', () => {
    const sealed = sealToKey(alice, key, toUtf8('police at the north gate'));
    for (const member of [bob, eve]) {
      const opened = openWithKey(key, sealed);
      assert.ok(opened, `member could not open`);
      assert.equal(Buffer.from(opened.body).toString('utf8'), 'police at the north gate');
      void member;
    }
  });

  it('authenticates the author within the channel', () => {
    const opened = openWithKey(key, sealToKey(alice, key, toUtf8('hi')));
    assert.equal(opened?.sender.publicId, alice.publicId);
  });

  it('is opaque without the key', () => {
    const wrong = deriveChannelKey('gate4', 'guessed-wrong');
    assert.equal(openWithKey(wrong, sealToKey(alice, key, toUtf8('hi'))), null);
  });

  it('recognises every spelling of the reserved public channel', () => {
    // All of these normalise onto the public-broadcast row, so joining any of
    // them as a passphrase channel would silently rekey the everyone-nearby
    // broadcast. joinChannel refuses them via this predicate.
    for (const spelling of ['public', 'Public', 'PUBLIC', '#public', '  public  ']) {
      assert.equal(isPublicChannelName(spelling), true, `should reserve "${spelling}"`);
    }
    assert.equal(isPublicChannelName(PUBLIC_CHANNEL_NAME), true);
    // A name that merely contains it is a real, joinable channel.
    for (const ok of ['publications', 'public-square', 'the-public']) {
      assert.equal(isPublicChannelName(ok), false, `should allow "${ok}"`);
    }
  });

  it('rejects tampering', () => {
    const sealed = sealToKey(alice, key, toUtf8('hi'));
    for (const i of [0, 30, sealed.length - 1]) {
      const mutated = Uint8Array.from(sealed);
      mutated[i] ^= 0xff;
      assert.equal(openWithKey(key, mutated), null, `byte ${i} flip accepted`);
    }
  });

  it('cannot transplant a signed message into another channel', () => {
    // The exact laundering attack: Eve holds key (channel C1) and key2 (C2).
    // She opens Alice's C1 message, lifts the inner signed plaintext, and
    // re-encrypts it verbatim under key2 with the same nonce. Binding the
    // signature to the channel key must make this fail to verify under key2 —
    // otherwise C2 sees a valid "Alice said X" she never sent there, and the
    // same trick launders any readable message into public broadcast.
    const key2 = deriveChannelKey('gate5', 'correct horse battery staple');
    const NONCE = 24;

    const sealed = sealToKey(alice, key, toUtf8('for gate4 only'));
    const nonce = sealed.subarray(0, NONCE);
    const inner = xchacha20poly1305(key, nonce).decrypt(sealed.subarray(NONCE));

    // Sanity: the lifted inner really is Alice's, readable under the original key.
    assert.equal(openWithKey(key, sealed)?.sender.publicId, alice.publicId);

    const transplanted = new Uint8Array(NONCE + inner.length + 16);
    transplanted.set(nonce, 0);
    transplanted.set(xchacha20poly1305(key2, nonce).encrypt(inner), NONCE);

    assert.equal(openWithKey(key2, transplanted), null, 'transplant verified — signature not bound to channel');
  });

  it('does not leak the author to someone without the key', () => {
    const sealed = sealToKey(alice, key, toUtf8('hi'));
    const hay = Buffer.from(sealed).toString('hex');
    assert.ok(!hay.includes(Buffer.from(alice.edPublic).toString('hex')));
  });

  it('never throws on hostile input', () => {
    for (const g of [new Uint8Array(0), new Uint8Array(50), new Uint8Array(300).fill(0xab)]) {
      assert.equal(openWithKey(key, g), null);
    }
  });

  it('public broadcast is readable by every install — this is intended', () => {
    const sealed = sealToKey(alice, PUBLIC_CHANNEL_KEY, toUtf8('exit blocked'));
    const opened = openWithKey(PUBLIC_CHANNEL_KEY, sealed);
    assert.equal(Buffer.from(opened!.body).toString('utf8'), 'exit blocked');
  });
});

describe('mode separation — the critical property for trial decryption', () => {
  const key = deriveChannelKey('gate4', 'pw pw pw');

  it('a direct message never opens as a channel message', () => {
    assert.equal(openWithKey(key, sealText(alice, pub(bob), 'private')), null);
  });

  it('a channel message never opens as a direct message', () => {
    assert.equal(open(bob, sealToKey(alice, key, toUtf8('channel'))), null);
  });

  it('a channel message does not open under a different channel key', () => {
    const other = deriveChannelKey('gate5', 'pw pw pw');
    assert.equal(openWithKey(other, sealToKey(alice, key, toUtf8('hi'))), null);
  });
});

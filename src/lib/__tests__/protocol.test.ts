/**
 * Wire-format tests.
 *
 * Every envelope this code will ever see arrives from a stranger's radio, so
 * the decoder is attack surface. Its job is to return null, never to throw and
 * never to over-read.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toUtf8 } from '../bytes';
import type { Envelope } from '../protocol';
import {
  DEFAULTS,
  EnvelopeType,
  HEADER_LEN,
  MAX_HOPS,
  PROTOCOL_VERSION,
  TIME_GRANULARITY_MS,
  decodeBody,
  decodeEnvelope,
  encodeBody,
  encodeEnvelope,
  isExpired,
  pad,
  unpad,
} from '../protocol';

const sample = (over: Partial<Envelope> = {}): Envelope => ({
  version: PROTOCOL_VERSION,
  type: EnvelopeType.Sealed,
  id: new Uint8Array(16).fill(9),
  createdAt: 1_700_000_040_000,
  ttlSeconds: DEFAULTS.ttlSeconds,
  hopCount: 0,
  maxHops: DEFAULTS.maxHops,
  payload: toUtf8('payload'),
  ...over,
});

describe('envelope encoding', () => {
  it('round-trips', () => {
    const e = sample();
    const decoded = decodeEnvelope(encodeEnvelope(e));
    assert.ok(decoded);
    assert.equal(decoded.type, e.type);
    assert.equal(decoded.ttlSeconds, e.ttlSeconds);
    assert.equal(decoded.maxHops, e.maxHops);
    assert.deepEqual([...decoded.id], [...e.id]);
    assert.deepEqual([...decoded.payload], [...e.payload]);
  });

  it('rounds timestamps down to the granularity — precise clocks are fingerprints', () => {
    const decoded = decodeEnvelope(encodeEnvelope(sample({ createdAt: 1_700_000_047_321 })));
    assert.equal(decoded!.createdAt % TIME_GRANULARITY_MS, 0);
    assert.equal(decoded!.createdAt, 1_700_000_040_000);
  });

  it('keeps the header at the documented size', () => {
    assert.equal(encodeEnvelope(sample({ payload: new Uint8Array(0) })).length, HEADER_LEN);
  });

  it('preserves hop count so relays can increment it', () => {
    assert.equal(decodeEnvelope(encodeEnvelope(sample({ hopCount: 4 })))!.hopCount, 4);
  });
});

describe('envelope decoding is hostile-input safe', () => {
  it('rejects short buffers', () => {
    for (let n = 0; n < HEADER_LEN; n++) assert.equal(decodeEnvelope(new Uint8Array(n)), null);
  });

  it('rejects a bad magic', () => {
    const raw = encodeEnvelope(sample());
    raw[0] = 0x00;
    assert.equal(decodeEnvelope(raw), null);
  });

  it('rejects an unknown version', () => {
    const raw = encodeEnvelope(sample());
    raw[2] = 99;
    assert.equal(decodeEnvelope(raw), null);
  });

  it('rejects an unknown type', () => {
    const raw = encodeEnvelope(sample());
    raw[3] = 77;
    assert.equal(decodeEnvelope(raw), null);
  });

  it('rejects a declared length that disagrees with the buffer', () => {
    const raw = encodeEnvelope(sample());
    // Claim a much longer payload than is actually present.
    new DataView(raw.buffer, raw.byteOffset, raw.byteLength).setUint16(32, 9999);
    assert.equal(decodeEnvelope(raw), null);
  });

  it('rejects an absurd TTL rather than trusting a stranger', () => {
    const raw = encodeEnvelope(sample());
    new DataView(raw.buffer, raw.byteOffset, raw.byteLength).setUint32(26, 0xffffffff);
    assert.equal(decodeEnvelope(raw), null);
  });

  it('clamps an inflated maxHops to the design cap', () => {
    // An attacker writes 255 into the maxHops byte to make honest relays carry
    // the envelope far deeper than the 6-hop cap. Decode must clamp it.
    const raw = encodeEnvelope(sample());
    raw[31] = 255;
    const decoded = decodeEnvelope(raw);
    assert.ok(decoded);
    assert.equal(decoded.maxHops, MAX_HOPS);
  });

  it('rejects a zero TTL', () => {
    const raw = encodeEnvelope(sample());
    new DataView(raw.buffer, raw.byteOffset, raw.byteLength).setUint32(26, 0);
    assert.equal(decodeEnvelope(raw), null);
  });

  it('never throws on random bytes', () => {
    for (let i = 0; i < 500; i++) {
      const raw = new Uint8Array(Math.floor(Math.random() * 120));
      crypto.getRandomValues(raw);
      assert.doesNotThrow(() => decodeEnvelope(raw));
    }
  });

  it('refuses to encode an oversized payload', () => {
    assert.throws(() => encodeEnvelope(sample({ payload: new Uint8Array(40_000) })));
  });

  it('refuses to encode a wrong-length id', () => {
    assert.throws(() => encodeEnvelope(sample({ id: new Uint8Array(8) })));
  });
});

describe('padding', () => {
  it('round-trips', () => {
    for (const n of [0, 1, 100, 252, 1000, 5000]) {
      const body = new Uint8Array(n).fill(3);
      assert.deepEqual([...unpad(pad(body))!], [...body]);
    }
  });

  it('collapses different lengths into the same bucket', () => {
    // A one-word answer and a street address must be indistinguishable by size.
    assert.equal(pad(toUtf8('ok')).length, pad(toUtf8('meet behind the third barricade')).length);
  });

  it('grows in buckets, not linearly', () => {
    const sizes = new Set([10, 50, 200].map((n) => pad(new Uint8Array(n)).length));
    assert.equal(sizes.size, 1);
  });

  it('rejects a corrupt length prefix', () => {
    const padded = pad(toUtf8('hi'));
    new DataView(padded.buffer).setUint32(0, 999_999);
    assert.equal(unpad(padded), null);
  });
});

describe('expiry', () => {
  it('expires past the TTL', () => {
    const e = sample({ createdAt: 1_000_000, ttlSeconds: 60 });
    assert.equal(isExpired(e, 1_000_000 + 59_000), false);
    assert.equal(isExpired(e, 1_000_000 + 61_000), true);
  });
});

describe('message bodies', () => {
  it('round-trips text', () => {
    const body = { kind: 'text', text: 'hello', sentAt: 123 } as const;
    assert.deepEqual(decodeBody(encodeBody(body)), body);
  });

  it('returns null on junk rather than throwing', () => {
    for (const junk of ['', 'null', '{]', '{"kind":"evil"}', '{"kind":"text"}']) {
      assert.equal(decodeBody(junk), null);
    }
  });
});

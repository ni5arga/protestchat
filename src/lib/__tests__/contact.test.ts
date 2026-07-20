import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONTACT_CODE_PREFIX,
  MAX_CONTACT_NAME_LENGTH,
  cleanContactName,
  publicIdFromContactCode,
} from '../contact';
import { identityFromSeed } from '../crypto-core';

const publicId = identityFromSeed(new Uint8Array(32).fill(7)).publicId;

describe('contact codes', () => {
  it('accepts raw and namespaced public ids', () => {
    assert.equal(publicIdFromContactCode(publicId), publicId);
    assert.equal(publicIdFromContactCode(`${CONTACT_CODE_PREFIX}${publicId}`), publicId);
    assert.equal(publicIdFromContactCode(`  ${CONTACT_CODE_PREFIX}${publicId}  `), publicId);
  });

  it('rejects malformed codes and a prefix embedded inside other text', () => {
    assert.equal(publicIdFromContactCode('not a contact'), null);
    assert.equal(publicIdFromContactCode(`ignore-${CONTACT_CODE_PREFIX}${publicId}`), null);
  });
});

describe('contact names', () => {
  it('trims a chosen local name', () => {
    assert.equal(cleanContactName('  River  '), 'River');
  });

  it('rejects an empty name', () => {
    assert.equal(cleanContactName('   '), null);
  });

  it('enforces the stored name limit', () => {
    assert.equal(cleanContactName('x'.repeat(100)), 'x'.repeat(MAX_CONTACT_NAME_LENGTH));
  });

  it('does not split multi-byte characters at the name limit', () => {
    assert.equal(
      cleanContactName('🌊'.repeat(MAX_CONTACT_NAME_LENGTH + 1)),
      '🌊'.repeat(MAX_CONTACT_NAME_LENGTH),
    );
  });
});

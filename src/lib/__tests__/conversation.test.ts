import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTranslator } from '../../i18n/core';
import type { Contact, Group } from '../db';
import { describeConversation } from '../conversation';

const i18n = createTranslator('en');

function contact(publicId: string, verified: boolean): Contact {
  return { publicId, name: publicId, verified, firstSeen: 0, lastSeen: 0 };
}

function group(members: string[]): Group {
  return { id: 'g1', name: 'Legal support', members, createdAt: 0 };
}

describe('describeConversation — group verification tone', () => {
  it('is ok/green only when every member is verified', () => {
    const info = describeConversation(
      '~g1',
      {
        channels: [],
        groups: [group(['a', 'b'])],
        contacts: [contact('a', true), contact('b', true)],
      },
      i18n,
    );
    assert.equal(info.tone, 'ok');
    assert.match(info.warning, /Encrypted separately/);
  });

  it('turns caution/amber when any member is unverified', () => {
    const info = describeConversation(
      '~g1',
      {
        channels: [],
        groups: [group(['a', 'b'])],
        contacts: [contact('a', true), contact('b', false)],
      },
      i18n,
    );
    assert.equal(info.tone, 'caution');
    assert.match(info.warning, /1.*not been verified/);
  });

  it('treats a member with no contact record as unverified', () => {
    const info = describeConversation(
      '~g1',
      {
        channels: [],
        groups: [group(['a', 'ghost'])],
        contacts: [contact('a', true)],
      },
      i18n,
    );
    assert.equal(info.tone, 'caution');
  });

  it('counts every unverified member in the plural warning', () => {
    const info = describeConversation(
      '~g1',
      {
        channels: [],
        groups: [group(['a', 'b', 'c'])],
        contacts: [contact('a', false), contact('b', false), contact('c', true)],
      },
      i18n,
    );
    assert.equal(info.tone, 'caution');
    assert.match(info.warning, /2.*not been verified/);
  });
});

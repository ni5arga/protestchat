/**
 * Deep links must never land directly on an armed verification confirmation
 * (issue #34) — only a prior in-app arm for that exact id, within the
 * window, consumes true.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { armVerification, consumeVerificationArm } from '../verify-session';

describe('verify session arming', () => {
  it('is unarmed for an id that was never armed, as with a cold deep link', () => {
    assert.equal(consumeVerificationArm('never-armed'), false);
  });

  it('arms only the exact id the in-app button pressed', () => {
    armVerification('alice');
    assert.equal(consumeVerificationArm('bob'), false);
    assert.equal(consumeVerificationArm('alice'), true);
  });

  it('is single-use — a second mount for the same id is unarmed', () => {
    armVerification('alice');
    assert.equal(consumeVerificationArm('alice'), true);
    assert.equal(consumeVerificationArm('alice'), false);
  });

  it('expires after the arm window', () => {
    const armedAt = 1_000_000;
    armVerification('alice', armedAt);
    assert.equal(consumeVerificationArm('alice', armedAt + 10 * 60 * 1000), false);
  });

  it('is still armed just inside the window', () => {
    const armedAt = 1_000_000;
    armVerification('alice', armedAt);
    assert.equal(consumeVerificationArm('alice', armedAt + 4 * 60 * 1000), true);
  });
});

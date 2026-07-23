import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shouldAutoStartRadio } from '../radio-pref';

describe('shouldAutoStartRadio (#71)', () => {
  it('starts only when BLE is ready and the user has not turned radio off', () => {
    assert.equal(shouldAutoStartRadio(true, true), true);
    assert.equal(shouldAutoStartRadio(true, false), false, 'manual off must stick');
    assert.equal(shouldAutoStartRadio(false, true), false);
    assert.equal(shouldAutoStartRadio(false, false), false);
  });
});

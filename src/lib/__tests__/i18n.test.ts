import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SUPPORTED_LANGUAGES,
  catalogs,
  createTranslator,
  formatClockTime,
  isLanguagePreference,
  resolveLanguage,
} from '../../i18n/core';
import { en } from '../../i18n/en';

const placeholders = (value: string) =>
  [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((match) => match[1]).sort();

describe('language resolution', () => {
  it('normalises regional and underscore locale tags', () => {
    assert.equal(resolveLanguage(['hi-IN']), 'hi');
    assert.equal(resolveLanguage(['bn_BD']), 'bn');
    assert.equal(resolveLanguage(['te-IN']), 'te');
  });

  it('uses the first supported preference and falls back to English', () => {
    assert.equal(resolveLanguage(['fr-FR', 'mr-IN', 'en-IN']), 'mr');
    assert.equal(resolveLanguage(['fr-FR', null]), 'en');
  });

  it('rejects corrupt persisted preferences', () => {
    assert.equal(isLanguagePreference('system'), true);
    assert.equal(isLanguagePreference('ta'), true);
    assert.equal(isLanguagePreference('fr'), false);
    assert.equal(isLanguagePreference(null), false);
  });
});

describe('translation catalogs', () => {
  it('contain exactly the English keys with matching placeholders', () => {
    const expectedKeys = Object.keys(en).sort();
    for (const language of SUPPORTED_LANGUAGES) {
      const catalog = catalogs[language];
      assert.deepEqual(Object.keys(catalog).sort(), expectedKeys, `${language} key mismatch`);
      for (const key of expectedKeys) {
        const value = catalog[key as keyof typeof en];
        assert.ok(value.trim(), `${language}:${key} is empty`);
        assert.deepEqual(
          placeholders(value),
          placeholders(en[key as keyof typeof en]),
          `${language}:${key} placeholder mismatch`,
        );
      }
    }
  });

  it('interpolates values without changing unknown placeholders', () => {
    const { t } = createTranslator('en');
    assert.equal(t('home.contactA11y.verified', { name: 'River' }), 'River. Verified.');
    assert.equal(t('home.contactA11y.verified'), '{name}. Verified.');
  });

  it('selects singular and plural copy for every language', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const { plural } = createTranslator(language);
      assert.ok(plural('status.connectedTitle', 1).includes('1'));
      assert.ok(plural('status.connectedTitle', 3).includes('3'));
    }
  });

  it('formats message times without seconds', () => {
    assert.match(formatClockTime(Date.UTC(2026, 0, 1, 8, 5), 'en'), /^\d{1,2}:\d{2}(?:\s?[AP]M)?$/i);
  });
});

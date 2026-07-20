import { en, type Catalog, type MessageKey } from './en';
import { bn } from './bn';
import { hi } from './hi';
import { mr } from './mr';
import { ta } from './ta';
import { te } from './te';

export const SUPPORTED_LANGUAGES = ['en', 'hi', 'bn', 'mr', 'te', 'ta'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export type LanguagePreference = 'system' | SupportedLanguage;
export type TranslationValues = Record<string, string | number>;

const catalogs: Record<SupportedLanguage, Catalog> = { en, hi, bn, mr, te, ta };

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || SUPPORTED_LANGUAGES.includes(value as SupportedLanguage);
}

export function resolveLanguage(languageCodes: readonly (string | null | undefined)[]): SupportedLanguage {
  for (const languageCode of languageCodes) {
    const normalised = languageCode?.trim().toLowerCase().split(/[-_]/)[0];
    if (SUPPORTED_LANGUAGES.includes(normalised as SupportedLanguage)) {
      return normalised as SupportedLanguage;
    }
  }
  return 'en';
}

function interpolate(template: string, values: TranslationValues = {}): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

function pluralCategory(language: SupportedLanguage, count: number): 'one' | 'other' {
  const absolute = Math.abs(count);
  if (language === 'hi' || language === 'bn' || language === 'mr') {
    return absolute === 0 || absolute === 1 ? 'one' : 'other';
  }
  return absolute === 1 ? 'one' : 'other';
}

export function formatClockTime(ms: number, language: SupportedLanguage): string {
  if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
    try {
      return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(ms);
    } catch {
      // Older Hermes builds do not always include the requested locale data.
    }
  }

  const date = new Date(ms);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function createTranslator(language: SupportedLanguage) {
  const catalog = catalogs[language];
  const t = (key: MessageKey, values?: TranslationValues): string =>
    interpolate(catalog[key] || en[key], values);
  const plural = (base: string, count: number, values: TranslationValues = {}): string => {
    const category = pluralCategory(language, count);
    const key = `${base}.${category}` as MessageKey;
    const fallbackKey = `${base}.other` as MessageKey;
    return interpolate(catalog[key] || catalog[fallbackKey] || en[key] || en[fallbackKey], {
      ...values,
      count,
    });
  };
  return { t, plural };
}

export type Translator = ReturnType<typeof createTranslator>;
export { catalogs };

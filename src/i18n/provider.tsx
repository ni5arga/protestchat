import * as SecureStore from 'expo-secure-store';
import { useLocales } from 'expo-localization';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  createTranslator,
  isLanguagePreference,
  resolveLanguage,
  type LanguagePreference,
  type SupportedLanguage,
  type Translator,
} from './core';

const LANGUAGE_KEY = 'protestchat.language.v1';

type I18nContextValue = Translator & {
  language: SupportedLanguage;
  preference: LanguagePreference;
  setPreference: (preference: LanguagePreference) => Promise<void>;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function savedPreference(): LanguagePreference {
  try {
    const value = SecureStore.getItem(LANGUAGE_KEY);
    return isLanguagePreference(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const locales = useLocales();
  const [preference, setPreferenceState] = useState<LanguagePreference>(savedPreference);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const systemLanguage = resolveLanguage(locales.map((locale) => locale.languageCode));
  const language = preference === 'system' ? systemLanguage : preference;
  const translator = useMemo(() => createTranslator(language), [language]);

  const setPreference = useCallback((next: LanguagePreference) => {
    if (!isLanguagePreference(next)) return Promise.reject(new Error('Unsupported language preference.'));
    const save = writeQueue.current.then(async () => {
      await SecureStore.setItemAsync(LANGUAGE_KEY, next);
      setPreferenceState(next);
    });
    writeQueue.current = save.catch(() => undefined);
    return save;
  }, []);

  const value = useMemo(
    () => ({ ...translator, language, preference, setPreference }),
    [language, preference, setPreference, translator],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}

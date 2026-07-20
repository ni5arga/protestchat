/**
 * Settings, and the honest-limitations notice.
 *
 * That notice is not boilerplate and should not be moved, shortened, collapsed,
 * or hidden behind a link. People make decisions about their physical safety
 * based on whether they believe this app works. They are entitled to know
 * exactly what it does not do, in the app, before they need it.
 *
 * It is deliberately the largest block on this screen and set at reading size
 * rather than fine-print size. Small grey text at the bottom of a settings
 * screen is the universal visual grammar for "nobody is expected to read this",
 * and this is the one thing here that everybody should.
 */

import { Stack } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { Bullets, Button, Card, Field, Input, Notice, Screen, Tag } from '@/components/ui';
import { Spacing, TAP_TARGET, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { type LanguagePreference, SUPPORTED_LANGUAGES } from '@/i18n/core';
import { useI18n } from '@/i18n/provider';
import { useApp } from '@/lib/app-state';

const REPO_URL = 'https://github.com/ni5arga/protestchat';

const LANGUAGE_NAMES: Record<Exclude<LanguagePreference, 'system'>, string> = {
  en: 'English',
  hi: 'हिन्दी (Hindi)',
  bn: 'বাংলা (Bengali)',
  mr: 'मराठी (Marathi)',
  te: 'తెలుగు (Telugu)',
  ta: 'தமிழ் (Tamil)',
};

export default function SettingsScreen() {
  const t = useTheme();
  const { t: copy, preference, setPreference } = useI18n();
  const { displayName, setDisplayName, status, startRadio, stopRadio, panicWipe } = useApp();
  const [name, setName] = useState(displayName);
  const [languageError, setLanguageError] = useState<string | null>(null);

  const limitations = [
    copy('settings.limitationUnlocked'),
    copy('settings.limitationLocation'),
    copy('settings.limitationShoulder'),
    copy('settings.limitationContact'),
  ];

  const runWipe = async () => {
    try {
      await panicWipe();
    } catch (err) {
      // A wipe that did not fully complete must never pass silently — the user
      // may be about to hand this phone over believing it is clean.
      Alert.alert(
        copy('settings.wipeIncompleteTitle'),
        copy('settings.wipeIncompleteDetail', {
          error: err instanceof Error ? err.message : copy('settings.wipeIncompleteUnknown'),
        }),
      );
    }
  };

  const confirmWipe = () =>
    Alert.alert(
      copy('settings.deleteTitle'),
      copy('settings.deleteDetail'),
      [
        { text: copy('common.cancel'), style: 'cancel' },
        { text: copy('common.deleteEverything'), style: 'destructive', onPress: () => void runWipe() },
      ],
    );

  return (
    <Screen contentStyle={{ gap: Spacing.xl }}>
      <Stack.Screen options={{ title: copy('nav.settings') }} />

      <Card style={{ gap: Spacing.md }}>
        <Text style={[Type.bodyStrong, { color: t.text }]}>{copy('language.title')}</Text>
        <Text style={[Type.caption, { color: t.textMuted }]}>{copy('language.hint')}</Text>
        {(['system', ...SUPPORTED_LANGUAGES] as LanguagePreference[]).map((value) => {
          const selected = preference === value;
          const label = value === 'system' ? copy('language.system') : LANGUAGE_NAMES[value];
          return (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              accessibilityLabel={label}
              onPress={() => {
                if (selected) return;
                setLanguageError(null);
                void setPreference(value).catch(() => setLanguageError(copy('language.saveError')));
              }}
              style={({ pressed }) => [
                styles.languageRow,
                { borderColor: selected ? t.accent : t.border, opacity: pressed ? 0.7 : 1 },
              ]}>
              <View
                style={[
                  styles.radio,
                  { borderColor: selected ? t.accent : t.borderStrong },
                ]}>
                {selected && <View style={[styles.radioDot, { backgroundColor: t.accent }]} />}
              </View>
              <Text style={[Type.body, { color: t.text, flex: 1 }]}>{label}</Text>
            </Pressable>
          );
        })}
        {!!languageError && (
          <Text accessibilityRole="alert" style={[Type.caption, { color: t.tone.danger.fg }]}>
            {languageError}
          </Text>
        )}
      </Card>

      <Card style={{ gap: Spacing.lg }}>
        <Field
          label={copy('settings.name')}
          hint={copy('settings.nameHint')}>
          <Input value={name} onChangeText={setName} placeholder="anon" maxLength={32} />
        </Field>
        <Button
          title={copy('common.save')}
          variant="secondary"
          onPress={() => void setDisplayName(name)}
          disabled={name.trim() === displayName}
        />
      </Card>

      <Card>
        <View style={styles.switchRow}>
          <View style={{ flex: 1, gap: Spacing.xs }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.md }}>
              <Text style={[Type.bodyStrong, { color: t.text }]}>{copy('settings.meshRadio')}</Text>
              {/* The word, not just the switch position: a switch read at a
                  glance in bright sun is two grey rectangles. */}
              <Tag tone={status.running ? 'ok' : 'danger'} label={status.running ? copy('common.on') : copy('common.off')} />
            </View>
            <Text style={[Type.callout, { color: t.textMuted }]}>
              {status.running
                ? copy('settings.radioOnDetail')
                : copy('settings.radioOffDetail')}
            </Text>
          </View>
          <Switch
            value={status.running}
            onValueChange={(on) => void (on ? startRadio() : stopRadio())}
            accessibilityLabel={copy('settings.meshRadio')}
          />
        </View>
      </Card>

      <Notice tone="danger" title={copy('settings.panicWipe')}>
        <Text style={[Type.callout, { color: t.text }]}>
          {copy('settings.panicDetail')}
        </Text>
        <Button
          title={copy('common.deleteEverything')}
          variant="danger"
          onPress={confirmWipe}
          style={{ marginTop: Spacing.sm }}
        />
      </Notice>

      <View style={[styles.honest, { borderColor: t.border }]}>
        <Text accessibilityRole="header" style={[Type.title, { color: t.text }]}>
          {copy('settings.limitationsTitle')}
        </Text>
        <Bullets items={limitations} />
        <Text style={[Type.callout, { color: t.textMuted }]}>
          {copy('settings.auditWarning')}
        </Text>
      </View>

      {/* Open source is a safety claim here, not a badge: the reason to trust
          this app is that anyone can read exactly what it does. So the source
          link is a first-class, tappable part of the screen. */}
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={copy('settings.openSourceA11y')}
        onPress={() => void Linking.openURL(REPO_URL)}
        style={({ pressed }) => [styles.footer, { opacity: pressed ? 0.6 : 1 }]}>
        <Text style={[Type.calloutStrong, { color: t.text, textAlign: 'center' }]}>
          {copy('settings.openSource')}
        </Text>
        <Text style={[Type.caption, { color: t.accent, textAlign: 'center' }]}>
          github.com/ni5arga/protestchat
        </Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  languageRow: {
    minHeight: TAP_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: Spacing.md,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.lg,
    minHeight: TAP_TARGET - Spacing.lg,
  },
  honest: {
    gap: Spacing.lg,
    paddingTop: Spacing.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footer: {
    minHeight: TAP_TARGET,
    gap: Spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.lg,
  },
});

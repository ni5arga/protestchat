/**
 * Safety number comparison.
 *
 * The only defence against someone having handed you a contact code that is not
 * theirs. Both phones derive the same 15 digits from the two public keys; if
 * the digits match, nobody is sitting in the middle.
 *
 * Written for someone who has never heard the phrase "man in the middle" and
 * should not have to.
 *
 * The digits get the largest type in the app and sit in three short rows,
 * because the actual physical act here is two people holding two phones at
 * arm's length reading numbers off each other's screens. A single fifteen-digit
 * run is the layout most likely to make someone skim, agree, and be wrong.
 */

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Button, Notice, Screen, Tag } from '@/components/ui';
import { Fonts, Radius, Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/i18n/provider';
import { useApp } from '@/lib/app-state';

export default function VerifyScreen() {
  const t = useTheme();
  const { t: copy } = useI18n();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const peerId = decodeURIComponent(id ?? '');

  const { contacts, safetyNumberFor, verifyContact } = useApp();
  const contact = contacts.find((c) => c.publicId === peerId);
  const digits = safetyNumberFor(peerId);
  const rows = digits ? digits.split(' ') : [];

  return (
    <Screen contentStyle={{ gap: Spacing.xl }}>
      <Stack.Screen options={{ title: contact?.name ?? copy('verify.title') }} />

      <View style={{ gap: Spacing.md }}>
        <Text style={[Type.hero, { color: t.text }]}>{copy('verify.heading')}</Text>
        <Text style={[Type.body, { color: t.textMuted }]}>
          {copy('verify.detail')}
        </Text>
      </View>

      <View
        // The full 60-digit number read out digit by digit, so a screen-reader
        // user compares it the same way two sighted people do — aloud, one digit
        // at a time — rather than as "twelve thousand…".
        accessibilityLabel={digits ? digits.replace(/ /g, '').split('').join(' ') : ''}
        style={[styles.plate, { backgroundColor: t.surface, borderColor: t.border }]}>
        {rows.length > 0 ? (
          rows.map((group, i) => (
            <Text key={`${group}-${i}`} selectable style={[styles.digits, { color: t.text }]}>
              {group}
            </Text>
          ))
        ) : (
          <Text style={[styles.digits, { color: t.textMuted }]}>—</Text>
        )}
      </View>

      <Notice tone="caution">
        <Text style={[Type.callout, { color: t.text }]}>
          {copy('verify.inPerson')}
        </Text>
      </Notice>

      {contact?.verified ? (
        <View style={{ gap: Spacing.lg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.md }}>
            <Tag tone="ok" label={copy('common.verified')} />
            <Text style={[Type.callout, { color: t.textMuted, flex: 1 }]}>
              {copy('verify.checked')}
            </Text>
          </View>
          <Button
            title={copy('common.undo')}
            variant="secondary"
            onPress={() => void verifyContact(peerId, false)}
          />
        </View>
      ) : (
        <View style={{ gap: Spacing.md }}>
          <Button
            title={copy('verify.match')}
            onPress={async () => {
              await verifyContact(peerId, true);
              router.back();
            }}
          />
          {/* Destructive styling on "they do not match" is correct: if the
              digits differ, someone is sitting between the two of you, and the
              calm-looking option is the dangerous one. */}
          <Button title={copy('verify.noMatch')} variant="danger" onPress={() => router.back()} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  // The number is 60 digits (12 groups of 5), so the groups wrap into a grid
  // rather than a 12-row column. Each group is a fixed-width monospace cell so
  // the columns line up and stay easy to track along while reading aloud.
  plate: {
    borderRadius: Radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: Spacing.xl,
    paddingHorizontal: Spacing.lg,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    rowGap: Spacing.md,
    columnGap: Spacing.lg,
  },
  digits: {
    fontFamily: Fonts.mono,
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: 3,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
});

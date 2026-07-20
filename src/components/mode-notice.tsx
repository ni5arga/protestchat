/**
 * The conversation mode warning. The most safety-critical pixels in the app.
 *
 * Rules, all of them load-bearing:
 *
 *   - Never dismissible, never collapsible, never behind a disclosure. There is
 *     no prop to hide it and none should be added.
 *   - Loudness is inverse to privacy. Public broadcast gets a solid red band
 *     with the largest text on the screen after the message you are writing;
 *     a fully private conversation gets a quiet line. Someone typing a location
 *     into a megaphone believing it is private is the worst thing this app can
 *     do to a person, so the megaphone has to look like one.
 *   - No padlock, no shield, no icon at all. A padlock reads as "safe" and two
 *     of the four modes are not safe in that sense. The eyebrow is a word.
 *   - It is full-bleed and attached to the header. A rounded floating card
 *     reads as a notification — something that arrived and can be swiped away.
 *     This did not arrive; it is what the room is.
 *   - No entrance animation. Every other element in this app may fade in; this
 *     one is legible in the first frame, because the frame where it is still
 *     at 40% opacity is a frame where someone can start typing.
 *
 * The warning sentence itself is never written here — it comes verbatim from
 * `describeConversation()`, which is the single place the modes are defined.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Spacing, TAP_TARGET, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/i18n/provider';
import type { ConversationInfo } from '@/lib/conversation';

/**
 * The word above the sentence. Chosen so that the eyebrow alone, read at a
 * glance with no colour perception at all, still ranks the four modes
 * correctly: NOT PRIVATE > SHARED PASSPHRASE > NOT VERIFIED > ENCRYPTED.
 */
function eyebrowFor(info: ConversationInfo, copy: ReturnType<typeof useI18n>['t']): string {
  switch (info.mode) {
    case 'public':
      return copy('mode.notPrivate');
    case 'channel':
      return copy('mode.sharedPassphrase');
    case 'group':
      return copy('mode.encryptedMembers');
    case 'direct':
      return info.tone === 'ok' ? copy('mode.encrypted') : copy('mode.notVerified');
  }
}

export function ModeNotice({ info, onPress }: { info: ConversationInfo; onPress?: () => void }) {
  const t = useTheme();
  const { t: copy } = useI18n();
  const c = t.tone[info.tone];
  const eyebrow = eyebrowFor(info, copy);

  // Only public broadcast gets the solid fill. Reserving it for exactly one
  // mode is what keeps it meaning something — a red band that shows up on
  // three screens out of four is a band nobody sees any more.
  const loud = info.mode === 'public';

  const bg = loud ? c.fill : info.tone === 'ok' ? t.bg : c.tint;
  const fg = loud ? c.onFill : c.fg;
  const bodyColor = loud ? c.onFill : info.tone === 'ok' ? t.textMuted : t.text;

  const body = (
    <View style={styles.inner}>
      <Text style={[Type.label, { color: fg }]}>{eyebrow.toUpperCase()}</Text>
      <Text style={[loud ? Type.bodyStrong : Type.callout, { color: bodyColor }]}>
        {info.warning}
      </Text>
      {!!onPress && (
        <Text style={[Type.label, { color: fg, marginTop: Spacing.xs }]}>
          {copy('mode.checkSafetyNumber').toUpperCase()}
        </Text>
      )}
    </View>
  );

  const frame = [
    styles.frame,
    {
      backgroundColor: bg,
      borderBottomColor: loud ? c.fill : info.tone === 'ok' ? t.border : c.edge,
      // The loud band gets a heavier rule so it still separates from a dark
      // message list when the fill itself is dark-ish in light mode.
      borderBottomWidth: loud ? 2 : StyleSheet.hairlineWidth,
    },
  ];

  // Announced to screen readers as an alert, so a blind user is told what kind
  // of room they are in rather than having to swipe to the top to find out.
  const a11y = {
    accessibilityRole: 'alert' as const,
    accessibilityLabel: `${eyebrow}. ${info.warning}`,
    accessibilityLiveRegion: 'polite' as const,
  };

  if (!onPress) {
    return (
      <View {...a11y} style={frame}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      {...a11y}
      accessibilityRole="button"
      accessibilityHint={copy('mode.openSafetyHint')}
      onPress={onPress}
      style={({ pressed }) => [frame, { opacity: pressed ? 0.8 : 1 }]}>
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  frame: { minHeight: TAP_TARGET },
  inner: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    gap: Spacing.xs + 2,
  },
});

/**
 * One message, and the rules for stacking several from the same sender.
 *
 * Consecutive messages from one person inside a few minutes collapse into a
 * single block with one name and one timestamp. That is a density decision but
 * also a legibility one: in a channel where six people are shouting about a
 * blocked exit, the thing you need to find fast is where one voice stops and
 * the next begins.
 *
 * Delivery state is deliberately worded, not iconographic. "Waiting for someone
 * in range" is the normal, healthy state of a message in a store-and-forward
 * mesh and must never render like a failure — a user who reads a queued message
 * as failed will walk somewhere dangerous to re-send it.
 */

import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Duration, Radius, Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatClockTime } from '@/i18n/core';
import { useI18n } from '@/i18n/provider';
import type { Message } from '@/lib/db';

/** Messages closer together than this from one sender are drawn as one block. */
const GROUP_WINDOW_MS = 4 * 60 * 1000;

export function groupsWithPrevious(
  m: Message | undefined,
  previous: Message | undefined,
): boolean {
  // Both ends are guarded because the chat screen calls this in both
  // directions: once with the previous message to decide grouping, and once
  // with the NEXT message (which is undefined for the last row) to decide
  // whether this is the tail of a block. An undefined on either side simply
  // means "no neighbour there", which is never a group.
  if (!m || !previous) return false;
  if (previous.outgoing !== m.outgoing) return false;
  if (previous.senderId !== m.senderId) return false;
  return m.sentAt - previous.sentAt < GROUP_WINDOW_MS;
}

function stateLabel(m: Message, copy: ReturnType<typeof useI18n>['t']): string {
  switch (m.state) {
    case 'queued':
      return copy('message.waiting');
    case 'sent':
      return copy('message.sent');
    case 'delivered':
      return copy('message.delivered');
    case 'failed':
      return copy('message.failed');
  }
}

export function MessageBubble({
  message,
  senderName,
  joined,
  last,
}: {
  message: Message;
  /** Null in direct chats, and on every message after the first of a block. */
  senderName: string | null;
  /** Continues the block above it. */
  joined: boolean;
  /** Last of its block — carries the timestamp and the delivery state. */
  last: boolean;
}) {
  const t = useTheme();
  const { t: copy, language } = useI18n();
  const mine = message.outgoing;
  const failed = message.state === 'failed';

  const corner = {
    borderTopLeftRadius: mine ? Radius.lg : joined ? Radius.sm : Radius.lg,
    borderTopRightRadius: mine ? (joined ? Radius.sm : Radius.lg) : Radius.lg,
    borderBottomLeftRadius: mine ? Radius.lg : Radius.sm,
    borderBottomRightRadius: mine ? Radius.sm : Radius.lg,
  };

  const meta = [last ? formatClockTime(message.sentAt, language) : null, mine && last ? stateLabel(message, copy) : null]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <Animated.View
      entering={FadeIn.duration(Duration.base)}
      style={{
        alignItems: mine ? 'flex-end' : 'flex-start',
        marginTop: joined ? 2 : Spacing.lg,
      }}>
      {!!senderName && (
        <Text style={[Type.micro, { color: t.textMuted, marginBottom: 4, marginLeft: Spacing.md }]}>
          {senderName}
        </Text>
      )}

      <View
        // The whole bubble is one node to a screen reader, so a swipe reads the
        // message and its state together instead of stranding "Delivered" as an
        // orphan below it.
        accessibilityRole="text"
        accessibilityLabel={[senderName, message.text, meta].filter(Boolean).join('. ')}
        style={[
          styles.bubble,
          corner,
          { backgroundColor: mine ? t.bubbleOut : t.bubbleIn },
          failed && { borderWidth: 1, borderColor: t.tone.danger.fg },
        ]}>
        <Text selectable style={[Type.body, { color: mine ? t.onBubbleOut : t.text }]}>
          {message.text}
        </Text>
      </View>

      {!!meta && (
        <Text
          // Muted and small on purpose: the timestamp is context, never the
          // thing you are reading the screen for. A notch below caption so it
          // recedes further under the message it belongs to.
          style={[
            Type.caption,
            {
              fontSize: 11,
              lineHeight: 14,
              color: failed ? t.tone.danger.fg : t.textFaint,
              marginTop: 4,
              marginHorizontal: Spacing.xs,
            },
          ]}>
          {meta}
        </Text>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    maxWidth: '84%',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md - 1,
  },
});

/**
 * A conversation — direct, group, channel, or public broadcast.
 *
 * The mode notice at the top is the most important element on this screen and
 * is never dismissible, never collapsible, and never quieter for the less
 * private modes. Someone typing a location into public broadcast because it
 * looked like a normal chat is the worst thing this app can do to a person.
 *
 * For the same reason the composer placeholder names, per mode, exactly who is
 * about to read what you type. It is the last thing on the screen before the
 * keyboard and therefore the last thing read before typing — which makes it the
 * cheapest place in the whole app to stop that mistake.
 */

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  KeyboardStickyView,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MessageBubble, groupsWithPrevious } from '@/components/message-bubble';
import { ModeNotice } from '@/components/mode-notice';
import { Button, Empty, Input } from '@/components/ui';
import { Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/i18n/provider';
import { useApp } from '@/lib/app-state';
import { describeConversation, type ConversationInfo } from '@/lib/conversation';
import * as db from '@/lib/db';

export default function ChatScreen() {
  const t = useTheme();
  const i18n = useI18n();
  const { t: copy, plural } = i18n;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = decodeURIComponent(id ?? '');

  const { contacts, conversations, channels, groups, sendText, status } = useApp();
  const contact = contacts.find((c) => c.publicId === conversationId);
  const group = conversationId.startsWith('~')
    ? groups.find((g) => g.id === conversationId.slice(1))
    : undefined;

  const info = useMemo(
    () =>
      describeConversation(conversationId, {
        channels,
        groups,
        contactName: contact?.name,
        verified: contact?.verified,
      }, i18n),
    [conversationId, channels, groups, contact, i18n],
  );

  const [messages, setMessages] = useState<db.Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<db.Message>>(null);

  const nameFor = useCallback(
    (publicId: string | null) =>
      publicId ? (contacts.find((c) => c.publicId === publicId)?.name ?? copy('common.unknown')) : copy('common.unknown'),
    [contacts, copy],
  );

  const load = useCallback(async () => {
    if (!conversationId) return;
    setMessages(await db.listMessages(conversationId));
    // Anything visible on this screen counts as read. Marking on every load
    // (not just first mount) covers messages that arrive while the chat is open.
    await db.markConversationRead(conversationId);
  }, [conversationId]);

  useEffect(() => {
    // State is updated only after the asynchronous SQLite read completes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, conversations]);

  // Messages arrive over the radio, not from anything React knows about, so a
  // modest poll is the honest way to keep this list live.
  useEffect(() => {
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [load]);

  const onSend = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendText(conversationId, text);
      setDraft('');
      await load();
    } catch {
      setError(copy('common.couldNotSend'));
    } finally {
      setSending(false);
    }
  };

  const danger = info.mode === 'public';

  // The composer sits above the keyboard via KeyboardStickyView, but that moves
  // only the composer — the message list behind it stays full-height, so the
  // keyboard covers the newest bubbles. This spacer, appended to the list and
  // grown to the live keyboard height, lifts the content by exactly that much
  // so the last message clears the keyboard and the floating composer together.
  // `height` from keyboard-controller is the native IME inset animation; Math.abs
  // guards the sign, which differs across versions.
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const listSpacer = useAnimatedStyle(() => ({ height: Math.abs(keyboardHeight.value) }));

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen
        options={{
          title: info.title,
          headerRight:
            info.mode === 'direct' && contact
              ? () => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={copy('contact.renameA11y', { name: contact.name })}
                    hitSlop={16}
                    onPress={() => router.push(`/contact/${encodeURIComponent(conversationId)}`)}>
                    {({ pressed }) => (
                      <Text
                        style={[
                          Type.calloutStrong,
                          { color: t.accent, opacity: pressed ? 0.6 : 1 },
                        ]}>
                        {copy('contact.edit')}
                      </Text>
                    )}
                  </Pressable>
                )
              : undefined,
        }}
      />

      <ModeNotice
        info={info}
        // Only the unverified-direct warning leads anywhere: verification is the
        // one warning a user can actually act on from here.
        onPress={
          info.mode === 'direct' && !contact?.verified
            ? () => router.push(`/verify/${encodeURIComponent(conversationId)}`)
            : undefined
        }
      />

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={[
          styles.list,
          // Messages settle to the bottom like a conversation should; an empty
          // conversation centres its explanation instead of stranding it above
          // the keyboard.
          messages.length ? styles.listFilled : styles.listEmpty,
        ]}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        keyboardDismissMode="interactive"
        // Grows with the keyboard, so opening it scrolls the newest bubbles up
        // above both the keyboard and the floating composer.
        ListFooterComponent={<Animated.View style={listSpacer} />}
        ListEmptyComponent={
          <Empty
            title={emptyTitle(info, copy)}
            detail={
              status.connected.length > 0
                ? copy('chat.connectedEmpty')
                : copy('chat.notInRangeEmpty')
            }
          />
        }
        renderItem={({ item, index }) => {
          const joined = groupsWithPrevious(item, messages[index - 1]);
          const last = !groupsWithPrevious(messages[index + 1], item);
          return (
            <MessageBubble
              message={item}
              joined={joined}
              last={last}
              senderName={
                info.showSenders && !item.outgoing && !joined ? nameFor(item.senderId) : null
              }
            />
          );
        }}
      />

      {error && (
        <Text
          accessibilityRole="alert"
          style={[
            Type.caption,
            { color: t.tone.danger.fg, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
          ]}>
          {error}
        </Text>
      )}

      {/* Pins the composer to the top of the keyboard. `opened: insets.bottom`
          drops the resting safe-area padding once the keyboard covers the home
          indicator, so the input sits flush on the keys. */}
      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
        <View
          style={[
            styles.composer,
            {
              backgroundColor: t.bg,
              paddingBottom: insets.bottom || Spacing.lg,
              // In public broadcast the rule above the keyboard is red too. By
              // the time the keyboard is up the warning band has scrolled off the
              // user's attention even though it is still on screen, and this is
              // the one moment where being reminded still changes the outcome.
              borderTopColor: danger ? t.tone.danger.fill : t.border,
              borderTopWidth: danger ? 2 : StyleSheet.hairlineWidth,
            },
          ]}>
          <Input
            value={draft}
            onChangeText={setDraft}
            placeholder={placeholderFor(info, group?.members.length ?? 0, copy, plural, contact?.name)}
            multiline
            style={{ flex: 1, maxHeight: 132 }}
          />
          <Button
            title={copy('common.send')}
            onPress={onSend}
            disabled={!draft.trim() || sending}
            style={{ paddingHorizontal: Spacing.lg }}
          />
        </View>
      </KeyboardStickyView>
    </View>
  );
}

/**
 * Who is about to read this. Never the word "Message" — a neutral placeholder
 * is exactly the affordance that makes a broadcast feel like a private chat.
 */
function placeholderFor(
  info: ConversationInfo,
  memberCount: number,
  copy: ReturnType<typeof useI18n>['t'],
  plural: ReturnType<typeof useI18n>['plural'],
  contactName?: string,
): string {
  switch (info.mode) {
    case 'public':
      return copy('chat.placeholder.public');
    case 'channel':
      return copy('chat.placeholder.channel');
    case 'group':
      return plural('chat.placeholder.group', memberCount);
    case 'direct':
      return info.tone === 'ok'
        ? copy('chat.placeholder.direct', { name: contactName ?? copy('chat.placeholder.directFallback') })
        : copy('chat.placeholder.unverified');
  }
}

function emptyTitle(info: ConversationInfo, copy: ReturnType<typeof useI18n>['t']): string {
  switch (info.mode) {
    case 'public':
      return copy('chat.empty.public');
    case 'channel':
      return copy('chat.empty.channel');
    case 'group':
      return copy('chat.empty.group');
    case 'direct':
      return copy('chat.empty.direct');
  }
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.lg,
    flexGrow: 1,
  },
  listFilled: { justifyContent: 'flex-end' },
  listEmpty: { justifyContent: 'center' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
  },
});

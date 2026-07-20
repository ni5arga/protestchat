/**
 * Home.
 *
 * Answers two questions and nothing else: "is it working?" and "who can I talk
 * to?" Anything that is not one of those two answers belongs on another screen.
 *
 * The status banner takes the top of the screen because in a jammed square that
 * first question is genuinely urgent and the second one is not.
 *
 * Ordering below it is deliberate. Public broadcast sits first because it is
 * what someone reaches for in an emergency, and it carries a permanent
 * NOT PRIVATE tag so that being first never reads as being safe. The list of
 * people you have actually verified sits last because reaching it should
 * require a small, deliberate scroll rather than a panicked thumb.
 */

import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StatusBanner } from '@/components/status-banner';
import { Button, Card, Empty, List, Monogram, Row, Screen, SectionHeader, Tag } from '@/components/ui';
import { Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useApp } from '@/lib/app-state';

export default function HomeScreen() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { status, contacts, conversations, channels, groups, refresh, ready } = useApp();

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const last = new Map(conversations.map((c) => [c.peerId, c]));
  const open = (id: string) => router.push(`/chat/${encodeURIComponent(id)}`);

  const publicChannel = channels.find((c) => c.kind === 'public');
  const joined = channels.filter((c) => c.kind === 'channel');

  return (
    <Screen
      contentStyle={{ paddingTop: insets.top + Spacing.sm }}
      footer={<Button title="Add a person" onPress={() => router.push('/add')} />}>
      <View style={styles.topBar}>
        <Text style={[Type.label, { color: t.textMuted }]}>PROTESTCHAT</Text>
        <Pressable
          hitSlop={16}
          accessibilityRole="button"
          accessibilityLabel="Settings"
          onPress={() => router.push('/settings')}>
          {({ pressed }) => (
            <Text style={[Type.label, { color: t.accent, opacity: pressed ? 0.6 : 1 }]}>
              SETTINGS
            </Text>
          )}
        </Pressable>
      </View>

      <StatusBanner status={status} />

      {publicChannel && (
        <>
          <SectionHeader title="Broadcast" />
          <List>
            <Row
              title="Everyone nearby"
              subtitle={last.get('#public')?.lastText ?? 'Crowd warnings only. Never names or plans.'}
              unread={last.get('#public')?.unread ?? 0}
              onPress={() => open('#public')}
              accessibilityLabel="Everyone nearby. Not private — anyone in range can read this."
              // The tag repeats what the chat screen's red band will say. Saying
              // it twice is cheap; discovering it after sending is not.
              tag={<Tag tone="danger" label="Not private" />}
            />
          </List>
        </>
      )}

      <SectionHeader title="Channels" action="Join" onAction={() => router.push('/join-channel')} />
      {joined.length === 0 ? (
        <Card>
          <Empty
            title="No channels yet"
            detail="A channel is a name and a passphrase, nothing else. Anyone you tell the passphrase to can read everything in it — including what was said before they arrived."
            action="Join a channel"
            onAction={() => router.push('/join-channel')}
          />
        </Card>
      ) : (
        <List>
          {joined.map((c) => (
            <Row
              key={c.id}
              title={`#${c.name}`}
              subtitle={last.get(`#${c.id}`)?.lastText ?? 'No messages yet'}
              unread={last.get(`#${c.id}`)?.unread ?? 0}
              onPress={() => open(`#${c.id}`)}
              tag={<Tag tone="caution" label="Shared key" />}
            />
          ))}
        </List>
      )}

      <SectionHeader title="Groups" action="New" onAction={() => router.push('/new-group')} />
      {groups.length === 0 ? (
        <Card>
          <Empty
            title="No groups yet"
            detail="A group is encrypted separately to every person you add, so only they can read it. There is no shared key to leak."
            action="Make a group"
            onAction={() => router.push('/new-group')}
          />
        </Card>
      ) : (
        <List>
          {groups.map((g) => (
            <Row
              key={g.id}
              title={g.name}
              subtitle={
                last.get(`~${g.id}`)?.lastText ??
                `${g.members.length} ${g.members.length === 1 ? 'person' : 'people'}`
              }
              onPress={() => open(`~${g.id}`)}
              unread={last.get(`~${g.id}`)?.unread ?? 0}
              tag={<Tag tone="ok" label="Private" />}
            />
          ))}
        </List>
      )}

      <SectionHeader title="People" />
      {contacts.length === 0 ? (
        <Card>
          <Empty
            title={ready ? 'Nobody added yet' : 'Starting up…'}
            detail="Stand next to someone and swap contact codes. It takes about ten seconds, and being in the same place is the whole reason it protects you — there is no server here to vouch for anyone."
            action={ready ? 'Add a person' : undefined}
            onAction={ready ? () => router.push('/add') : undefined}
          />
        </Card>
      ) : (
        <List>
          {contacts.map((c) => (
            <Row
              key={c.publicId}
              title={c.name}
              subtitle={last.get(c.publicId)?.lastText ?? 'No messages yet'}
              unread={last.get(c.publicId)?.unread ?? 0}
              onPress={() => open(c.publicId)}
              leading={<Monogram name={c.name} />}
              accessibilityLabel={`${c.name}. ${c.verified ? 'Verified' : 'Not verified'}.`}
              tag={
                <Tag tone={c.verified ? 'ok' : 'caution'} label={c.verified ? 'Verified' : 'Unverified'} />
              }
            />
          ))}
        </List>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xs,
    paddingBottom: Spacing.lg,
  },
});

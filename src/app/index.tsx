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
import { Button, Card, Empty, Leading, List, Row, Screen, SectionHeader, Tag } from '@/components/ui';
import { Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/i18n/provider';
import { useApp } from '@/lib/app-state';

export default function HomeScreen() {
  const t = useTheme();
  const { t: copy, plural } = useI18n();
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
      footer={<Button title={copy('common.addPerson')} onPress={() => router.push('/add')} />}>
      <View style={styles.topBar}>
        <Text style={[Type.label, { color: t.textMuted }]}>PROTESTCHAT</Text>
        <Pressable
          hitSlop={20}
          accessibilityRole="button"
          accessibilityLabel={copy('home.settingsA11y')}
          onPress={() => router.push('/settings')}>
          {({ pressed }) => (
            <Text style={[Type.label, { color: t.accent, opacity: pressed ? 0.6 : 1 }]}>
              {copy('common.settings').toUpperCase()}
            </Text>
          )}
        </Pressable>
      </View>

      <StatusBanner status={status} />

      {publicChannel && (
        <>
          <SectionHeader title={copy('home.broadcast')} />
          <List>
            <Row
              title={copy('home.everyoneNearby')}
              subtitle={last.get('#public')?.lastText ?? copy('home.crowdWarning')}
              unread={last.get('#public')?.unread ?? 0}
              onPress={() => open('#public')}
              leading={<Leading kind="broadcast" />}
              accessibilityLabel={copy('home.everyoneNearbyA11y')}
              // The tag repeats what the chat screen's red band will say. Saying
              // it twice is cheap; discovering it after sending is not.
              tag={<Tag tone="danger" label={copy('home.notPrivate')} />}
            />
          </List>
        </>
      )}

      <SectionHeader title={copy('home.channels')} action={copy('home.join')} onAction={() => router.push('/join-channel')} />
      {joined.length === 0 ? (
        <Card>
          <Empty
            compact
            title={copy('home.noChannelsTitle')}
            detail={copy('home.noChannelsDetail')}
            action={copy('home.joinChannel')}
            onAction={() => router.push('/join-channel')}
          />
        </Card>
      ) : (
        <List>
          {joined.map((c) => (
            <Row
              key={c.id}
              title={`#${c.name}`}
              subtitle={last.get(`#${c.id}`)?.lastText ?? copy('common.noMessages')}
              unread={last.get(`#${c.id}`)?.unread ?? 0}
              onPress={() => open(`#${c.id}`)}
              leading={<Leading kind="channel" />}
              tag={<Tag tone="caution" label={copy('home.sharedKey')} />}
            />
          ))}
        </List>
      )}

      <SectionHeader title={copy('home.groups')} action={copy('home.new')} onAction={() => router.push('/new-group')} />
      {groups.length === 0 ? (
        <Card>
          <Empty
            compact
            title={copy('home.noGroupsTitle')}
            detail={copy('home.noGroupsDetail')}
            action={copy('home.makeGroup')}
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
                plural('home.groupPeople', g.members.length)
              }
              onPress={() => open(`~${g.id}`)}
              unread={last.get(`~${g.id}`)?.unread ?? 0}
              leading={<Leading kind="group" name={g.name} />}
              tag={<Tag tone="ok" label={copy('home.private')} />}
            />
          ))}
        </List>
      )}

      <SectionHeader title={copy('home.people')} />
      {contacts.length === 0 ? (
        <Card>
          <Empty
            compact
            title={ready ? copy('home.nobodyTitle') : copy('common.starting')}
            detail={copy('home.nobodyDetail')}
            action={ready ? copy('common.addPerson') : undefined}
            onAction={ready ? () => router.push('/add') : undefined}
          />
        </Card>
      ) : (
        <List>
          {contacts.map((c) => (
            <Row
              key={c.publicId}
              title={c.name}
              subtitle={last.get(c.publicId)?.lastText ?? copy('common.noMessages')}
              unread={last.get(c.publicId)?.unread ?? 0}
              onPress={() => open(c.publicId)}
              leading={<Leading kind="person" name={c.name} />}
              accessibilityLabel={copy(c.verified ? 'home.contactA11y.verified' : 'home.contactA11y.unverified', { name: c.name })}
              tag={
                <Tag tone={c.verified ? 'ok' : 'caution'} label={c.verified ? copy('common.verified') : copy('common.unverified')} />
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

/**
 * Creating a closed group.
 *
 * Membership is local. This is *your* list of who you send to, not a
 * synchronised roster — two members can disagree about who is in the group.
 * That is a real limitation of fan-out and the screen says so rather than
 * pretending otherwise.
 *
 * The unverified-member warning appears the instant one is selected, above the
 * create button rather than after it. A warning that arrives once the group
 * exists is a warning about something you have already done.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button, Card, Empty, Field, Input, Notice, Screen, Tag } from '@/components/ui';
import { Radius, Spacing, TAP_TARGET, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/i18n/provider';
import { useApp } from '@/lib/app-state';
import { MAX_GROUP_MEMBERS } from '@/lib/conversation';

export default function NewGroupScreen() {
  const t = useTheme();
  const { t: copy, plural } = useI18n();
  const router = useRouter();
  const { contacts, createGroup } = useApp();

  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const toggle = (publicId: string) => {
    setError(null);
    setSelected((prev) => {
      if (prev.includes(publicId)) return prev.filter((p) => p !== publicId);
      if (prev.length >= MAX_GROUP_MEMBERS) {
        setError(copy('group.limit', { count: MAX_GROUP_MEMBERS }));
        return prev;
      }
      return [...prev, publicId];
    });
  };

  const onCreate = async () => {
    await createGroup(name, selected);
    router.back();
  };

  const unverifiedSelected = contacts.filter(
    (c) => selected.includes(c.publicId) && !c.verified,
  ).length;

  return (
    <Screen
      contentStyle={{ gap: Spacing.xl }}
      footer={
        <Button
          title={plural('group.create', selected.length)}
          onPress={() => void onCreate()}
          disabled={selected.length === 0}
        />
      }>
      <View style={{ gap: Spacing.sm }}>
        <Text style={[Type.hero, { color: t.text }]}>{copy('group.title')}</Text>
        <Text style={[Type.body, { color: t.textMuted }]}>
          {copy('group.detail')}
        </Text>
      </View>

      <Card>
        <Field label={copy('group.name')}>
          <Input value={name} onChangeText={setName} placeholder={copy('group.namePlaceholder')} autoFocus />
        </Field>
      </Card>

      <View style={{ gap: Spacing.md }}>
        <Text style={[Type.label, { color: t.textMuted }]}>
          {copy('group.membersCount', { selected: selected.length, maximum: MAX_GROUP_MEMBERS }).toUpperCase()}
        </Text>

        {contacts.length === 0 ? (
          <Card>
            <Empty
              title={copy('group.noContactsTitle')}
              detail={copy('group.noContactsDetail')}
            />
          </Card>
        ) : (
          <View style={{ gap: Spacing.sm }}>
            {contacts.map((c) => {
              const on = selected.includes(c.publicId);
              return (
                <Pressable
                  key={c.publicId}
                  onPress={() => toggle(c.publicId)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={copy(c.verified ? 'home.contactA11y.verified' : 'home.contactA11y.unverified', { name: c.name })}
                  style={({ pressed }) => [
                    styles.member,
                    {
                      borderColor: on ? t.accent : t.border,
                      backgroundColor: on ? t.surface : 'transparent',
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}>
                  <View
                    style={[
                      styles.check,
                      {
                        borderColor: on ? t.accentFill : t.borderStrong,
                        backgroundColor: on ? t.accentFill : 'transparent',
                      },
                    ]}>
                    {on && (
                      <Text style={{ color: t.onAccentFill, fontSize: 15, fontWeight: '700' }}>
                        ✓
                      </Text>
                    )}
                  </View>
                  <Text style={[Type.body, { color: t.text, flex: 1 }]} numberOfLines={1}>
                    {c.name}
                  </Text>
                  <Tag
                    tone={c.verified ? 'ok' : 'caution'}
                    label={c.verified ? copy('common.verified') : copy('common.unverified')}
                  />
                </Pressable>
              );
            })}
          </View>
        )}

        {!!error && (
          <Text accessibilityRole="alert" style={[Type.callout, { color: t.tone.danger.fg }]}>
            {error}
          </Text>
        )}
      </View>

      {unverifiedSelected > 0 && (
        <Notice
          tone="caution"
          title={plural('group.unverifiedTitle', unverifiedSelected)}>
          <Text style={[Type.callout, { color: t.text }]}>
            {copy('group.unverifiedDetail')}
          </Text>
        </Notice>
      )}

      <Text style={[Type.caption, { color: t.textMuted }]}>
        {copy('group.membershipDetail')}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  member: {
    minHeight: TAP_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: Radius.sm - 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

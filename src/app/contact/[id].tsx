import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';

import { Button, Card, Empty, Field, Input, Screen } from '@/components/ui';
import { Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/i18n/provider';
import { useApp } from '@/lib/app-state';
import { MAX_CONTACT_NAME_LENGTH, cleanContactName } from '@/lib/contact';

export default function ContactScreen() {
  const t = useTheme();
  const { t: copy } = useI18n();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const publicId = decodeURIComponent(id ?? '');
  const { ready, contacts, renameContact } = useApp();
  const contact = contacts.find((item) => item.publicId === publicId);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = draft ?? contact?.name ?? '';
  const chosen = cleanContactName(name);

  const save = async () => {
    if (!contact || !chosen || chosen === contact.name || saving) return;
    setSaving(true);
    setError(null);
    try {
      await renameContact(contact.publicId, chosen);
      router.back();
    } catch {
      setError(copy('contact.saveFailed'));
      setSaving(false);
    }
  };

  if (!ready || !contact) {
    return (
      <Screen contentStyle={{ flexGrow: 1, justifyContent: 'center' }}>
        <Stack.Screen options={{ title: copy('contact.person') }} />
        <Empty
          title={ready ? copy('contact.notFound') : copy('common.starting')}
          detail={ready ? copy('contact.removedDetail') : copy('contact.loadingDetail')}
          action={ready ? copy('contact.goBack') : undefined}
          onAction={ready ? () => router.back() : undefined}
        />
      </Screen>
    );
  }

  return (
    <Screen contentStyle={{ gap: Spacing.xl }}>
      <Stack.Screen options={{ title: copy('contact.editTitle') }} />

      <Text style={[Type.body, { color: t.textMuted }]}>
        {copy('contact.nameInstruction')}
      </Text>

      <Card style={{ gap: Spacing.lg }}>
        <Field
          label={copy('add.nameLabel')}
          hint={copy('contact.nameHint')}>
          <Input
            value={name}
            onChangeText={(value) => {
              setDraft(value);
              setError(null);
            }}
            accessibilityLabel={copy('add.nameLabel')}
            autoCapitalize="words"
            maxLength={MAX_CONTACT_NAME_LENGTH}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => void save()}
          />
        </Field>
        {!!error && (
          <Text
            selectable
            accessibilityRole="alert"
            style={[Type.callout, { color: t.tone.danger.fg }]}>
            {error}
          </Text>
        )}
        <Button
          title={saving ? copy('add.saving') : copy('contact.saveName')}
          onPress={() => void save()}
          disabled={!chosen || chosen === contact.name || saving}
        />
      </Card>
    </Screen>
  );
}

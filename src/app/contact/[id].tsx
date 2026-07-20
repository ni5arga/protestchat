import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';

import { Button, Card, Empty, Field, Input, Screen } from '@/components/ui';
import { Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useApp } from '@/lib/app-state';
import { MAX_CONTACT_NAME_LENGTH, cleanContactName } from '@/lib/contact';

export default function ContactScreen() {
  const t = useTheme();
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the name.');
      setSaving(false);
    }
  };

  if (!ready || !contact) {
    return (
      <Screen contentStyle={{ flexGrow: 1, justifyContent: 'center' }}>
        <Stack.Screen options={{ title: 'Person' }} />
        <Empty
          title={ready ? 'Person not found' : 'Starting up…'}
          detail={
            ready
              ? 'This person may have been removed from this phone.'
              : 'Loading the people stored on this phone.'
          }
          action={ready ? 'Go back' : undefined}
          onAction={ready ? () => router.back() : undefined}
        />
      </Screen>
    );
  }

  return (
    <Screen contentStyle={{ gap: Spacing.xl }}>
      <Stack.Screen options={{ title: 'Edit person' }} />

      <Text style={[Type.body, { color: t.textMuted }]}>
        This name is stored only on your phone. Changing it does not notify the other person or
        change whether you have verified them.
      </Text>

      <Card style={{ gap: Spacing.lg }}>
        <Field
          label="Name on this phone"
          hint="Use a nickname or role you will recognise quickly.">
          <Input
            value={name}
            onChangeText={(value) => {
              setDraft(value);
              setError(null);
            }}
            accessibilityLabel="Name on this phone"
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
          title={saving ? 'Saving…' : 'Save name'}
          onPress={() => void save()}
          disabled={!chosen || chosen === contact.name || saving}
        />
      </Card>
    </Screen>
  );
}

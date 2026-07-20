/**
 * Joining a channel.
 *
 * Key derivation is intentionally slow, so this screen shows real progress
 * rather than appearing frozen. The delay is a feature and is explained, not
 * apologised for.
 *
 * The three-line warning below the form is not fine print. A channel is the
 * only mode here whose confidentiality depends on something a human chose under
 * pressure, and "gate4 / delhi" shouted across a crowd is the realistic case.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { Bullets, Button, Card, Field, Input, Notice, Screen } from '@/components/ui';
import { Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/i18n/provider';
import { useApp } from '@/lib/app-state';

export default function JoinChannelScreen() {
  const t = useTheme();
  const { t: copy } = useI18n();
  const router = useRouter();
  const { joinChannel } = useApp();

  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onJoin = async () => {
    setBusy(true);
    setError(null);
    try {
      // Yield a frame first so the spinner actually paints before scrypt takes
      // over the JS thread — otherwise the UI just freezes for a beat.
      await new Promise((r) => setTimeout(r, 32));
      const channel = await joinChannel(name, passphrase);
      router.replace(`/chat/${encodeURIComponent(`#${channel.id}`)}`);
    } catch {
      setError(copy('common.couldNotJoin'));
      setBusy(false);
    }
  };

  return (
    <Screen contentStyle={{ gap: Spacing.xl }}>
      <View style={{ gap: Spacing.sm }}>
        <Text style={[Type.hero, { color: t.text }]}>{copy('join.title')}</Text>
        <Text style={[Type.body, { color: t.textMuted }]}>
          {copy('join.detail')}
        </Text>
      </View>

      <Card style={{ gap: Spacing.lg }}>
        <Field label={copy('join.channelName')}>
          <Input value={name} onChangeText={setName} placeholder="gate4" autoFocus />
        </Field>

        <Field label={copy('join.passphrase')}>
          <Input
            value={passphrase}
            onChangeText={setPassphrase}
            placeholder={copy('join.passphrasePlaceholder')}
            secureTextEntry
          />
        </Field>

        {!!error && (
          <Text accessibilityRole="alert" style={[Type.callout, { color: t.tone.danger.fg }]}>
            {error}
          </Text>
        )}

        {busy ? (
          <View
            accessibilityRole="progressbar"
            style={{ alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.lg }}>
            <ActivityIndicator color={t.accent} />
            <Text style={[Type.callout, { color: t.textMuted, textAlign: 'center' }]}>
              {copy('join.progress')}
            </Text>
          </View>
        ) : (
          <Button title={copy('join.action')} onPress={onJoin} disabled={!name.trim() || !passphrase} />
        )}
      </Card>

      <Notice tone="caution" title={copy('join.beforeUse')}>
        <Bullets
          items={[
            copy('join.caveatAccess'),
            copy('join.caveatNoAdmin'),
            copy('join.caveatGuessing'),
          ]}
          color={t.text}
        />
      </Notice>
    </Screen>
  );
}

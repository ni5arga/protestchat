/**
 * Adding a person.
 *
 * This screen is the trust anchor for the entire app. There is no server and no
 * directory, so the only thing that establishes who someone is, is the two of
 * you being in the same place and one phone reading the other's screen.
 *
 * So it is given the weight of a ritual rather than the weight of a form: one
 * thing on the screen at a time, the code presented large on a plaque, and the
 * reason the in-person part matters stated in full sentences instead of a hint.
 * The typed-code path exists only for a broken camera or a denied permission,
 * and stays visually secondary because a code that arrived over some other app
 * is a code that other app could have swapped.
 */

import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { Stack, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Button, Card, Field, Input, Screen } from '@/components/ui';
import { Radius, Spacing, TAP_TARGET, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useApp } from '@/lib/app-state';
import {
  CONTACT_CODE_PREFIX,
  MAX_CONTACT_NAME_LENGTH,
  cleanContactName,
  publicIdFromContactCode,
} from '@/lib/contact';

export default function AddScreen() {
  const t = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { identity, displayName, contacts, addContact } = useApp();

  const [mode, setMode] = useState<'show' | 'scan'>('show');
  const [permission, requestPermission] = useCameraPermissions();
  const [typed, setTyped] = useState('');
  const [pendingPublicId, setPendingPublicId] = useState<string | null>(null);
  const [contactName, setContactName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  const myCode = identity ? `${CONTACT_CODE_PREFIX}${identity.publicId}` : '';
  const qrSize = Math.min(width - Spacing.lg * 2 - Spacing.xl * 2, 268);

  const accept = (raw: string) => {
    const publicId = publicIdFromContactCode(raw);
    if (!publicId) {
      setError('That is not a valid contact code.');
      handled.current = false;
      return;
    }
    const existing = contacts.find((contact) => contact.publicId === publicId);
    setPendingPublicId(publicId);
    setContactName(existing?.name ?? '');
    setError(null);
  };

  const save = async () => {
    if (!pendingPublicId || saving) return;
    const chosen = cleanContactName(contactName);
    if (!chosen) {
      setError('Give this person a name you will recognise.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const ok = await addContact(pendingPublicId, chosen);
      if (!ok) {
        setError('That contact code is no longer valid.');
        setSaving(false);
        return;
      }
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this person.');
      setSaving(false);
    }
  };

  if (pendingPublicId) {
    const existing = contacts.some((contact) => contact.publicId === pendingPublicId);
    return (
      <Screen contentStyle={{ gap: Spacing.xl }}>
        <Stack.Screen options={{ title: existing ? 'Rename person' : 'Name this person' }} />

        <Text style={[Type.body, { color: t.textMuted }]}>
          Choose a name you will recognise later. It stays only on this phone and is never sent to
          them or anyone nearby.
        </Text>

        <Card style={{ gap: Spacing.lg }}>
          <Field
            label="Name on this phone"
            hint="Use a nickname or role, not necessarily a real name.">
            <Input
              value={contactName}
              onChangeText={(value) => {
                setContactName(value);
                setError(null);
              }}
              accessibilityLabel="Name on this phone"
              placeholder="Medic at north gate"
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
            title={saving ? 'Saving…' : existing ? 'Save new name' : 'Save person'}
            onPress={() => void save()}
            disabled={!cleanContactName(contactName) || saving}
          />
        </Card>

        <Button
          title="Use a different code"
          variant="quiet"
          disabled={saving}
          onPress={() => {
            setPendingPublicId(null);
            setContactName('');
            setTyped('');
            setError(null);
            handled.current = false;
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen contentStyle={{ gap: Spacing.xl }}>
      <Segmented
        value={mode}
        onChange={(next) => {
          setMode(next);
          if (next === 'scan') {
            handled.current = false;
            if (!permission?.granted) void requestPermission();
          }
        }}
      />

      {mode === 'show' ? (
        <View style={{ alignItems: 'center', gap: Spacing.lg }}>
          <Text style={[Type.label, { color: t.textMuted }]}>YOUR CODE</Text>
          <Text style={[Type.hero, { color: t.text }]} numberOfLines={1}>
            {displayName}
          </Text>

          <View style={styles.plaque}>
            {!!myCode && (
              // Always dark-on-white regardless of theme: a dark-mode QR code is
              // a QR code that half of scanners refuse to read.
              <QRCode value={myCode} size={qrSize} backgroundColor="#FFFFFF" color="#000000" />
            )}
          </View>

          <Text style={[Type.body, { color: t.text, textAlign: 'center', maxWidth: 340 }]}>
            Let the other person scan this while you are standing next to each other.
          </Text>
          <Text style={[Type.callout, { color: t.textMuted, textAlign: 'center', maxWidth: 340 }]}>
            Being in the same place is what makes it safe. Nothing here checks who anyone is —
            you do, by being there.
          </Text>

          <Button
            title="Copy code instead"
            variant="quiet"
            onPress={() => void Clipboard.setStringAsync(myCode)}
          />
        </View>
      ) : (
        <View style={{ gap: Spacing.lg }}>
          <View style={[styles.viewfinder, { backgroundColor: t.surfaceSunken }]}>
            {permission?.granted ? (
              <>
                <CameraView
                  style={StyleSheet.absoluteFill}
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={({ data }) => {
                    // The camera fires continuously; without this latch a single
                    // code adds the same contact dozens of times.
                    if (handled.current || !data.startsWith(CONTACT_CODE_PREFIX)) return;
                    handled.current = true;
                    accept(data);
                  }}
                />
                <Corners color={t.accent} />
              </>
            ) : (
              <View style={styles.fallback}>
                <Text style={[Type.body, { color: t.text, textAlign: 'center' }]}>
                  Camera access is off
                </Text>
                <Text
                  style={[
                    Type.callout,
                    { color: t.textMuted, textAlign: 'center', marginTop: Spacing.sm },
                  ]}>
                  You can still paste their code below, but only do that if you got it from them
                  in person.
                </Text>
              </View>
            )}
          </View>
          <Text style={[Type.body, { color: t.text, textAlign: 'center' }]}>
            Point this at the other phone’s code.
          </Text>
        </View>
      )}

      <Card style={{ gap: Spacing.md }}>
        <Field
          label="Or paste their code"
          hint="A code that reached you through another app could have been swapped on the way. Prefer the camera.">
          <Input
            value={typed}
            onChangeText={(v) => {
              setTyped(v);
              setError(null);
            }}
            placeholder="protestchat:…"
            accessibilityLabel="Paste their contact code"
            multiline
            style={{ minHeight: 84 }}
          />
        </Field>
        {!!error && (
          <Text accessibilityRole="alert" style={[Type.caption, { color: t.tone.danger.fg }]}>
            {error}
          </Text>
        )}
        <Button
          title="Add person"
          variant="secondary"
          onPress={() => accept(typed)}
          disabled={!typed.trim()}
        />
      </Card>
    </Screen>
  );
}

/** Two-way switch. Sized to the tap target because this is used one-handed. */
function Segmented({
  value,
  onChange,
}: {
  value: 'show' | 'scan';
  onChange: (v: 'show' | 'scan') => void;
}) {
  const t = useTheme();
  const options: { key: 'show' | 'scan'; label: string }[] = [
    { key: 'show', label: 'My code' },
    { key: 'scan', label: 'Scan theirs' },
  ];

  return (
    <View style={[styles.segmented, { backgroundColor: t.surface, borderColor: t.border }]}>
      {options.map((o) => {
        const on = value === o.key;
        return (
          <Pressable
            key={o.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={o.label}
            onPress={() => onChange(o.key)}
            style={({ pressed }) => [
              styles.segment,
              {
                backgroundColor: on ? t.accentFill : 'transparent',
                opacity: pressed ? 0.8 : 1,
              },
            ]}>
            <Text style={[Type.bodyStrong, { color: on ? t.onAccentFill : t.textMuted }]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Corner brackets rather than a full outline. They frame the target without
 * covering any of the code, and they say "aim" in a way a plain square does not.
 */
function Corners({ color }: { color: string }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={[styles.corner, styles.tl, { borderColor: color }]} />
      <View style={[styles.corner, styles.tr, { borderColor: color }]} />
      <View style={[styles.corner, styles.bl, { borderColor: color }]} />
      <View style={[styles.corner, styles.br, { borderColor: color }]} />
    </View>
  );
}

const B = 3;
const C = 34;

const styles = StyleSheet.create({
  segmented: {
    flexDirection: 'row',
    gap: Spacing.xs,
    padding: Spacing.xs,
    borderRadius: Radius.md + Spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  segment: {
    flex: 1,
    minHeight: TAP_TARGET - Spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.md,
  },
  plaque: {
    padding: Spacing.xl,
    backgroundColor: '#FFFFFF',
    borderRadius: Radius.xl,
  },
  viewfinder: {
    aspectRatio: 1,
    borderRadius: Radius.xl,
    overflow: 'hidden',
  },
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  corner: { position: 'absolute', width: C, height: C },
  tl: {
    top: Spacing.lg,
    left: Spacing.lg,
    borderTopWidth: B,
    borderLeftWidth: B,
    borderTopLeftRadius: Radius.md,
  },
  tr: {
    top: Spacing.lg,
    right: Spacing.lg,
    borderTopWidth: B,
    borderRightWidth: B,
    borderTopRightRadius: Radius.md,
  },
  bl: {
    bottom: Spacing.lg,
    left: Spacing.lg,
    borderBottomWidth: B,
    borderLeftWidth: B,
    borderBottomLeftRadius: Radius.md,
  },
  br: {
    bottom: Spacing.lg,
    right: Spacing.lg,
    borderBottomWidth: B,
    borderRightWidth: B,
    borderBottomRightRadius: Radius.md,
  },
});

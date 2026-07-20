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
import { useI18n } from '@/i18n/provider';
import { useApp } from '@/lib/app-state';
import { MAX_CONTACT_NAME_LENGTH, cleanContactName } from '@/lib/contact';
import { CONTACT_CODE_PREFIX, decodeContactCode } from '@/lib/contact-code';

export default function AddScreen() {
  const t = useTheme();
  const { t: copy } = useI18n();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { displayName, contactCode, contacts, addContact } = useApp();

  const [mode, setMode] = useState<'show' | 'scan'>('show');
  const [permission, requestPermission] = useCameraPermissions();
  const [typed, setTyped] = useState('');
  const [pendingPublicId, setPendingPublicId] = useState<string | null>(null);
  const [pendingCode, setPendingCode] = useState('');
  const [contactName, setContactName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  const myCode = contactCode;
  const qrSize = Math.min(width - Spacing.lg * 2 - Spacing.xl * 2, 268);

  const accept = (raw: string) => {
    const parsed = decodeContactCode(raw);
    if (!parsed) {
      setError(copy('add.invalidCode'));
      handled.current = false;
      return;
    }
    const publicId = parsed.identity.publicId;
    const existing = contacts.find((contact) => contact.publicId === publicId);
    // Stash the raw code, not just the id. A v2 code carries the peer's
    // receive-key bundle, and addContact() needs the whole string to establish
    // forward secrecy at introduction — passing only the publicId would silently
    // drop the prekeys and fall back to no-FS sealing.
    setPendingCode(raw.trim());
    setPendingPublicId(publicId);
    setContactName(existing?.name ?? '');
    setError(null);
  };

  const save = async () => {
    if (!pendingPublicId || saving) return;
    const chosen = cleanContactName(contactName);
    if (!chosen) {
      setError(copy('add.nameRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const ok = await addContact(pendingCode, chosen);
      if (!ok) {
        setError(copy('add.codeExpired'));
        setSaving(false);
        return;
      }
      router.back();
    } catch {
      setError(copy('add.saveFailed'));
      setSaving(false);
    }
  };

  if (pendingPublicId) {
    const existing = contacts.some((contact) => contact.publicId === pendingPublicId);
    return (
      <Screen contentStyle={{ gap: Spacing.xl }}>
        <Stack.Screen options={{ title: existing ? copy('add.renameTitle') : copy('add.nameTitle') }} />

        <Text style={[Type.body, { color: t.textMuted }]}>
          {copy('add.nameInstruction')}
        </Text>

        <Card style={{ gap: Spacing.lg }}>
          <Field
            label={copy('add.nameLabel')}
            hint={copy('add.nameHint')}>
            <Input
              value={contactName}
              onChangeText={(value) => {
                setContactName(value);
                setError(null);
              }}
              accessibilityLabel={copy('add.nameLabel')}
              placeholder={copy('add.namePlaceholder')}
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
            title={saving ? copy('add.saving') : existing ? copy('add.saveNewName') : copy('add.savePerson')}
            onPress={() => void save()}
            disabled={!cleanContactName(contactName) || saving}
          />
        </Card>

        <Button
          title={copy('add.differentCode')}
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
          <Text style={[Type.label, { color: t.textMuted }]}>{copy('add.yourCode').toUpperCase()}</Text>
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
            {copy('add.inPersonInstruction')}
          </Text>
          <Text style={[Type.callout, { color: t.textMuted, textAlign: 'center', maxWidth: 340 }]}>
            {copy('add.inPersonDetail')}
          </Text>

          <Button
            title={copy('add.copyCode')}
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
                  {copy('add.cameraOff')}
                </Text>
                <Text
                  style={[
                    Type.callout,
                    { color: t.textMuted, textAlign: 'center', marginTop: Spacing.sm },
                  ]}>
                  {copy('add.cameraOffDetail')}
                </Text>
              </View>
            )}
          </View>
          <Text style={[Type.body, { color: t.text, textAlign: 'center' }]}>
            {copy('add.pointCamera')}
          </Text>
        </View>
      )}

      <Card style={{ gap: Spacing.md }}>
        <Field
          label={copy('add.orPaste')}
          hint={copy('add.pasteHint')}>
          <Input
            value={typed}
            onChangeText={(v) => {
              setTyped(v);
              setError(null);
            }}
            placeholder="protestchat:…"
            accessibilityLabel={copy('add.pasteCodeA11y')}
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
          title={copy('add.addPerson')}
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
  const { t: copy } = useI18n();
  const options: { key: 'show' | 'scan'; label: string }[] = [
    { key: 'show', label: copy('add.myCode') },
    { key: 'scan', label: copy('add.scanTheirs') },
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

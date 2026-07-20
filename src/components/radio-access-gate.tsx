import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui';
import { Radius, Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  getRadioAccessStatus,
  openAppSettings,
  requestRadioAccess,
  subscribeToRadioAccess,
} from '@/lib/radio-access';
import type { BleState, BleStatus } from '../../modules/ble-mesh/src/BleMesh.types';

type GateCopy = {
  title: string;
  detail: string;
  action?: string;
};

function copyFor(status: BleStatus | null, appReady: boolean): GateCopy {
  if (!appReady) {
    return { title: 'Preparing securely', detail: 'Loading your identity and local messages.' };
  }
  switch (status?.state) {
    case 'unauthorized':
      return {
        title: 'Bluetooth permission required',
        detail:
          'Nearby messaging cannot work without Bluetooth access. Allow it in Settings, then return here.',
        action: 'Open Settings',
      };
    case 'poweredOff':
      return {
        title: 'Turn on Bluetooth',
        detail:
          Platform.OS === 'ios'
            ? 'Turn Bluetooth on in Control Centre or Settings. The app will unlock automatically.'
            : 'Approve the system Bluetooth prompt. The app will unlock automatically when Bluetooth is on.',
        action: Platform.OS === 'ios' ? 'Open Settings' : 'Turn on Bluetooth',
      };
    case 'locationOff':
      return {
        title: 'Turn on Location Services',
        detail:
          'Android 11 and older hide Bluetooth scan results while Location Services is off. No location data is stored or shared.',
        action: 'Open Location Settings',
      };
    case 'unsupported':
      return {
        title: 'Bluetooth unavailable',
        detail: status.message || 'This phone cannot run the nearby Bluetooth mesh.',
      };
    case 'resetting':
      return { title: 'Bluetooth is restarting', detail: 'Keep this screen open for a moment.' };
    default:
      return { title: 'Checking Bluetooth', detail: 'Bluetooth is required for nearby messaging.' };
  }
}

export function RadioAccessGate({
  appReady,
  startRadio,
  children,
}: {
  appReady: boolean;
  startRadio: () => Promise<void>;
  children: ReactNode;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<BleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [admitted, setAdmitted] = useState(false);
  const promptedState = useRef<BleState | null>(null);
  const mounted = useRef(true);

  const acceptStatus = useCallback(
    async (next: BleStatus) => {
      if (!mounted.current) return;
      setStatus(next);
      if (next.state !== 'ready') {
        setAdmitted(false);
        return;
      }
      await startRadio();
      if (mounted.current) setAdmitted(true);
    },
    [startRadio],
  );

  const request = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await requestRadioAccess();
      promptedState.current = next.state;
      await acceptStatus(next);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [acceptStatus, busy]);

  useEffect(() => {
    mounted.current = true;
    if (!appReady) return () => { mounted.current = false; };

    const unsubscribe = subscribeToRadioAccess((next) => {
      void acceptStatus(next);
    });
    const appStateSubscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void getRadioAccessStatus().then(acceptStatus);
    });
    void getRadioAccessStatus().then(acceptStatus);

    return () => {
      mounted.current = false;
      unsubscribe();
      appStateSubscription.remove();
    };
  }, [acceptStatus, appReady]);

  useEffect(() => {
    if (
      !appReady ||
      !status ||
      busy ||
      status.state === 'ready' ||
      status.state === 'resetting' ||
      status.state === 'unsupported' ||
      promptedState.current === status.state
    ) {
      return;
    }
    promptedState.current = status.state;
    void request();
  }, [appReady, busy, request, status]);

  if (appReady && status?.state === 'ready' && admitted) return children;

  const copy = copyFor(status, appReady);
  const openSettings = status?.state === 'unauthorized' ||
    (Platform.OS === 'ios' && status?.state === 'poweredOff');

  return (
    <View
      accessibilityViewIsModal
      style={[
        styles.root,
        {
          backgroundColor: t.bg,
          paddingTop: insets.top + Spacing.xxl,
          paddingBottom: insets.bottom + Spacing.xl,
        },
      ]}>
      <View style={styles.content}>
        <View
          style={[
            styles.icon,
            { backgroundColor: t.tone.caution.tint, borderColor: t.tone.caution.edge },
          ]}>
          <Text accessibilityElementsHidden style={[styles.bluetooth, { color: t.tone.caution.fg }]}>B</Text>
        </View>
        <Text accessibilityRole="header" style={[Type.hero, styles.center, { color: t.text }]}>
          {copy.title}
        </Text>
        <Text style={[Type.body, styles.center, { color: t.textMuted }]}>{copy.detail}</Text>
        {(busy || !status || !appReady || status.state === 'resetting') && (
          <ActivityIndicator color={t.accent} size="large" style={styles.progress} />
        )}
      </View>

      {!!copy.action && !busy && (
        <Button
          title={copy.action}
          onPress={() => {
            if (openSettings) void openAppSettings();
            else void request();
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: Spacing.xl,
    justifyContent: 'space-between',
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
  },
  icon: {
    width: 72,
    height: 72,
    borderRadius: Radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  bluetooth: {
    fontSize: 36,
    fontWeight: '700',
  },
  center: {
    textAlign: 'center',
    maxWidth: 360,
  },
  progress: {
    marginTop: Spacing.md,
  },
});

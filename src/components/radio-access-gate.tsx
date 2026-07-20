import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui';
import { Radius, Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/i18n/provider';
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

function copyFor(
  status: BleStatus | null,
  appReady: boolean,
  copy: ReturnType<typeof useI18n>['t'],
): GateCopy {
  if (!appReady) {
    return { title: copy('radio.preparingTitle'), detail: copy('radio.preparingDetail') };
  }
  switch (status?.state) {
    case 'unauthorized':
      return {
        title: copy('radio.permissionTitle'),
        detail: copy('radio.permissionDetail'),
        action: copy('radio.openSettings'),
      };
    case 'poweredOff':
      return {
        title: copy('radio.powerTitle'),
        detail:
          Platform.OS === 'ios'
            ? copy('radio.powerIosDetail')
            : copy('radio.powerAndroidDetail'),
        action: Platform.OS === 'ios' ? copy('radio.openSettings') : copy('radio.powerAction'),
      };
    case 'locationOff':
      return {
        title: copy('radio.locationTitle'),
        detail: copy('radio.locationDetail'),
        action: copy('radio.locationAction'),
      };
    case 'unsupported':
      return {
        title: copy('radio.unavailableTitle'),
        detail: copy('radio.unavailableDetail'),
      };
    case 'resetting':
      return { title: copy('radio.restartingTitle'), detail: copy('radio.restartingDetail') };
    default:
      return { title: copy('radio.checkingTitle'), detail: copy('radio.checkingDetail') };
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
  const { t: copyText } = useI18n();
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

  const copy = copyFor(status, appReady, copyText);
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

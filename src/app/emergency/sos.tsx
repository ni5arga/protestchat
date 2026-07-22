/**
 * SOS confirmation screen.
 *
 * A dedicated screen for sending an emergency alert. The user must hold the
 * button for 1.5 seconds — long enough to prevent accidental sends, short
 * enough that a person under stress can complete it.
 *
 * Design rules:
 *   - Single purpose: one action, one way to cancel
 *   - No distracting elements — the hold button fills the center of the screen
 *   - The progress ring gives continuous feedback during the hold
 *   - Releasing before completion always cancels — never ambiguous
 *   - Text is large and high-contrast — readable outdoors in sunlight
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Radius, Spacing, TAP_TARGET, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/i18n/provider';
import { EmergencyCategory, useApp } from '@/lib/app-state';

/** Hold duration required to confirm send, in milliseconds. */
const HOLD_DURATION_MS = 1500;

type SendState = 'idle' | 'holding' | 'sent' | 'error';

export default function SosScreen() {
  const t = useTheme();
  const { t: copy } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { category } = useLocalSearchParams<{ category: string }>();
  const { sendEmergency, canSendEmergency, sendSafeHeartbeat } = useApp();

  const [sendState, setSendState] = useState<SendState>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const holdProgress = useRef(new Animated.Value(0)).current;
  const holdAnimation = useRef<Animated.CompositeAnimation | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Validate the category param
  const validCategory = Object.values(EmergencyCategory).includes(category as EmergencyCategory)
    ? (category as EmergencyCategory)
    : null;

  const isSafeHeartbeat = category === 'heartbeat';
  const isRateLimited = validCategory ? !canSendEmergency(validCategory) : false;

  const stopHold = useCallback(() => {
    holdAnimation.current?.stop();
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (sendState === 'holding') {
      setSendState('idle');
      Animated.timing(holdProgress, {
        toValue: 0,
        duration: 200,
        useNativeDriver: false,
      }).start();
    }
  }, [sendState, holdProgress]);

  const startHold = useCallback(() => {
    if (sendState !== 'idle' || isRateLimited) return;

    setSendState('holding');
    holdProgress.setValue(0);

    holdAnimation.current = Animated.timing(holdProgress, {
      toValue: 1,
      duration: HOLD_DURATION_MS,
      useNativeDriver: false,
    });
    holdAnimation.current.start();

    holdTimer.current = setTimeout(async () => {
      holdAnimation.current = null;
      holdTimer.current = null;
      try {
        if (isSafeHeartbeat) {
          await sendSafeHeartbeat();
        } else if (validCategory) {
          await sendEmergency(validCategory);
        }
        setSendState('sent');
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Could not send');
        setSendState('error');
        Animated.timing(holdProgress, {
          toValue: 0,
          duration: 200,
          useNativeDriver: false,
        }).start();
      }
    }, HOLD_DURATION_MS);
  }, [sendState, isRateLimited, isSafeHeartbeat, validCategory, sendEmergency, sendSafeHeartbeat, holdProgress]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      holdAnimation.current?.stop();
      if (holdTimer.current) clearTimeout(holdTimer.current);
    };
  }, []);

  // Auto-navigate back after a successful send
  useEffect(() => {
    if (sendState === 'sent') {
      const timer = setTimeout(() => router.back(), 2000);
      return () => clearTimeout(timer);
    }
  }, [sendState, router]);

  const isHeartbeat = isSafeHeartbeat;
  const accentColor = isHeartbeat ? t.tone.ok.fill : t.tone.danger.fill;
  const accentText = isHeartbeat ? t.tone.ok.onFill : t.tone.danger.onFill;

  const categoryLabel = isHeartbeat
    ? copy('emergency.iAmSafe')
    : validCategory === EmergencyCategory.medical
      ? copy('emergency.medical')
      : validCategory === EmergencyCategory.unsafe
        ? copy('emergency.unsafe')
        : validCategory === EmergencyCategory.lostGroup
          ? copy('emergency.lostGroup')
          : copy('emergency.needHelp');

  const ringScale = holdProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.12],
  });
  const ringOpacity = holdProgress.interpolate({
    inputRange: [0, 0.1, 1],
    outputRange: [0, 1, 1],
  });

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: t.bg, paddingTop: insets.top, paddingBottom: insets.bottom + Spacing.xl },
      ]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={[Type.heading, { color: t.text }]}>{copy('emergency.sos.title')}</Text>
        <Pressable
          hitSlop={20}
          accessibilityRole="button"
          onPress={() => router.back()}>
          {({ pressed }) => (
            <Text style={[Type.body, { color: t.accent, opacity: pressed ? 0.6 : 1 }]}>
              {copy('emergency.sos.cancel')}
            </Text>
          )}
        </Pressable>
      </View>

      {/* Category label */}
      <Text style={[Type.title, styles.categoryLabel, { color: accentColor }]}>
        {categoryLabel}
      </Text>

      {/* Main hold area */}
      <View style={styles.holdArea}>
        {/* Animated ring behind the button */}
        <Animated.View
          style={[
            styles.holdRing,
            {
              borderColor: accentColor,
              opacity: ringOpacity,
              transform: [{ scale: ringScale }],
            },
          ]}
        />

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy('emergency.holdToSend')}
          onPressIn={startHold}
          onPressOut={stopHold}
          disabled={sendState === 'sent' || isRateLimited}>
          {({ pressed: _pressed }) => (
            <Animated.View
              style={[
                styles.holdButton,
                {
                  backgroundColor: sendState === 'sent' ? t.tone.ok.fill : accentColor,
                },
              ]}>
              <Text style={[Type.hero, { color: accentText, textAlign: 'center' }]}>
                {sendState === 'sent'
                  ? '✓'
                  : isHeartbeat
                    ? '🟢'
                    : '🆘'}
              </Text>
              <Text style={[Type.bodyStrong, { color: accentText, marginTop: Spacing.sm, textAlign: 'center' }]}>
                {sendState === 'sent'
                  ? copy('emergency.sent')
                  : sendState === 'holding'
                    ? copy('emergency.holdingToSend')
                    : categoryLabel}
              </Text>
            </Animated.View>
          )}
        </Pressable>
      </View>

      {/* Instruction text */}
      <View style={styles.instructions}>
        {isRateLimited ? (
          <Text style={[Type.body, { color: t.tone.caution.fg, textAlign: 'center' }]}>
            {copy('emergency.rateLimited')}
          </Text>
        ) : sendState === 'error' ? (
          <Text style={[Type.body, { color: t.tone.danger.fg, textAlign: 'center' }]}>
            {errorMessage}
          </Text>
        ) : sendState === 'sent' ? (
          <Text style={[Type.body, { color: t.tone.ok.fg, textAlign: 'center' }]}>
            {isHeartbeat ? copy('emergency.safeHeartbeatSent') : copy('emergency.sent')}
          </Text>
        ) : (
          <>
            <Text style={[Type.body, { color: t.textMuted, textAlign: 'center' }]}>
              {sendState === 'holding'
                ? copy('emergency.releaseToCancel')
                : copy('emergency.holdToSend')}
            </Text>
            {!isHeartbeat && (
              <Text
                style={[Type.callout, { color: t.textFaint, textAlign: 'center', marginTop: Spacing.md }]}>
                {copy('emergency.sos.trustWarning')}
              </Text>
            )}
          </>
        )}
      </View>

      {/* Progress bar at the bottom */}
      {sendState === 'holding' && (
        <Animated.View
          style={[
            styles.progressBar,
            {
              backgroundColor: accentColor,
              width: holdProgress.interpolate({
                inputRange: [0, 1],
                outputRange: ['0%', '100%'],
              }),
            },
          ]}
        />
      )}
    </View>
  );
}

const BUTTON_SIZE = 180;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: Spacing.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.lg,
  },
  categoryLabel: {
    textAlign: 'center',
    marginTop: Spacing.xl,
  },
  holdArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  holdRing: {
    position: 'absolute',
    width: BUTTON_SIZE + 32,
    height: BUTTON_SIZE + 32,
    borderRadius: (BUTTON_SIZE + 32) / 2,
    borderWidth: 3,
  },
  holdButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
    // Minimum tap target exceeded many times over
    minHeight: TAP_TARGET * 2,
  },
  instructions: {
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.xxl,
    alignItems: 'center',
    gap: Spacing.sm,
  },
  progressBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    height: 4,
    borderRadius: Radius.pill,
  },
});

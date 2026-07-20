/**
 * The single most important element in the app.
 *
 * In a jammed square the only question a user actually has is "is this thing
 * working right now?" — so that answer gets the largest type on the screen, in
 * plain words. No signal bars, no jargon, no "peers: 3".
 *
 * Every state carries a colour AND a word AND a sentence of explanation,
 * because in direct sunlight the colour is the first thing to become useless.
 *
 * The pulse is the only sustained motion in the app and it means one specific
 * thing: the radio is still looking. It stops the moment there is an answer, so
 * "something is moving" and "nothing has happened yet" are the same signal —
 * which is what makes a settled screen readable at a glance. Under reduced
 * motion it renders the settled frame; the state is never carried by movement
 * alone, only reinforced by it.
 */

import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Duration, Radius, Spacing, Type, type ToneName } from '@/constants/theme';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/i18n/provider';
import type { MeshStatus } from '@/lib/mesh';

type Described = {
  tone: ToneName;
  /** The one-word state, always rendered next to the colour. */
  state: string;
  headline: string;
  detail: string;
  /** True while the radio is still searching — drives the pulse and nothing else. */
  searching: boolean;
};

function describe(status: MeshStatus, i18n: ReturnType<typeof useI18n>): Described {
  const { t, plural } = i18n;
  if (!status.radioAvailable) {
    return {
      tone: 'danger',
      state: t('status.noRadioState'),
      headline: t('status.noRadioTitle'),
      detail: t('status.noRadioDetail'),
      searching: false,
    };
  }
  if (!status.running) {
    return {
      tone: 'danger',
      state: t('status.offState'),
      headline: t('status.offTitle'),
      detail: t('status.offDetail'),
      searching: false,
    };
  }

  const connected = status.connected.length;
  if (connected > 0) {
    return {
      tone: 'ok',
      state: t('status.connectedState'),
      headline: plural('status.connectedTitle', connected),
      detail: t('status.connectedDetail'),
      searching: false,
    };
  }
  if (status.peers.length > 0) {
    return {
      tone: 'caution',
      state: t('status.connectingState'),
      headline: t('status.connectingTitle'),
      detail: plural('status.foundNearby', status.peers.length),
      searching: true,
    };
  }
  return {
    tone: 'caution',
    state: t('status.searchingState'),
    headline: t('status.searchingTitle'),
    detail: t('status.searchingDetail'),
    searching: true,
  };
}

export function StatusBanner({ status }: { status: MeshStatus }) {
  const t = useTheme();
  const i18n = useI18n();
  const { tone, state, headline, detail, searching } = describe(status, i18n);
  const c = t.tone[tone];

  // Connected is the one settled, affirmative state — it earns a quieter, more
  // resolved look than searching: a static glow around the dot and a toned
  // hairline instead of the neutral border. Never carried by this alone; the
  // word, the colour and the sentence still say "connected" without it.
  const affirm = tone === 'ok';

  const carrying =
    status.carrying > 0
      ? i18n.plural('status.carrying', status.carrying)
      : null;
  const radioError = status.lastError ? i18n.t('status.unknownError') : null;

  return (
    <View
      accessibilityRole="summary"
      // Screen readers get the state word first, then the sentence — the same
      // order a sighted user reads it in.
      accessibilityLabel={[state + '.', headline + '.', detail, carrying, radioError]
        .filter(Boolean)
        .join(' ')}
      style={[
        styles.card,
        {
          backgroundColor: t.surface,
          borderColor: affirm ? c.edge : t.border,
          borderWidth: affirm ? 1 : StyleSheet.hairlineWidth,
        },
      ]}>
      <View style={styles.head}>
        <Beacon color={c.fg} active={searching} affirm={affirm} />
        <Text style={[Type.label, { color: c.fg }]}>{state.toUpperCase()}</Text>
      </View>

      <Text style={[Type.display, { color: t.text, marginTop: Spacing.md }]}>{headline}</Text>

      <Text style={[Type.body, { color: t.textMuted, marginTop: Spacing.sm }]}>{detail}</Text>

      {(carrying || radioError) && (
        <View style={[styles.meta, { borderColor: t.border }]}>
          {!!carrying && <Text style={[Type.caption, { color: t.textMuted }]}>{carrying}</Text>}
          {!!radioError && (
            <Text style={[Type.caption, { color: t.tone.danger.fg }]}>{radioError}</Text>
          )}
        </View>
      )}
    </View>
  );
}

/**
 * The dot, plus two rings that breathe outward only while searching.
 *
 * Deliberately not a spinner. A spinner says "wait, something is loading" and
 * implies it will finish; this can legitimately search for an hour in an empty
 * street, and the honest signal for that is "still listening", not "loading".
 */
function Beacon({
  color,
  active,
  affirm,
}: {
  color: string;
  active: boolean;
  affirm?: boolean;
}) {
  const motion = useMotion();
  const p = useSharedValue(0);
  const run = active && motion;

  useEffect(() => {
    if (!run) {
      cancelAnimation(p);
      p.value = 0;
      return;
    }
    p.value = 0;
    p.value = withRepeat(
      withTiming(1, { duration: Duration.pulse * 2, easing: Easing.out(Easing.quad) }),
      -1,
      false,
    );
    return () => cancelAnimation(p);
  }, [run, p]);

  // Two rings, half a cycle apart, so the rhythm reads as continuous rather
  // than as a repeating blink.
  const ringA = useAnimatedStyle(() => ringStyle(p.value));
  const ringB = useAnimatedStyle(() => ringStyle((p.value + 0.5) % 1));

  return (
    <View style={styles.beacon}>
      {run && (
        <>
          <Animated.View style={[styles.ring, { borderColor: color }, ringA]} />
          <Animated.View style={[styles.ring, { borderColor: color }, ringB]} />
        </>
      )}
      {/* Settled glow for a connection that has landed. Static, so reduced
          motion leaves it exactly as-is — it is decoration on a state already
          spelled out in words. */}
      {affirm && !run && <View style={[styles.halo, { backgroundColor: color }]} />}
      <View style={[styles.dot, { backgroundColor: color }]} />
    </View>
  );
}

function ringStyle(v: number) {
  'worklet';
  return {
    transform: [{ scale: interpolate(v, [0, 1], [0.7, 2.8]) }],
    opacity: interpolate(v, [0, 0.15, 1], [0, 0.5, 0]),
  };
}

const DOT = 12;

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.xl,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, height: 20 },
  beacon: { width: DOT, height: DOT, alignItems: 'center', justifyContent: 'center' },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  halo: {
    position: 'absolute',
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    opacity: 0.2,
    transform: [{ scale: 2.4 }],
  },
  ring: {
    position: 'absolute',
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    borderWidth: 1.5,
  },
  meta: {
    marginTop: Spacing.lg,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: Spacing.sm,
  },
});

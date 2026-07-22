/**
 * Emergency action grid.
 *
 * Six large tap targets arranged in a 2-column grid. Each button maps to one
 * EmergencyCategory or the safe heartbeat action. Buttons are large enough to
 * hit one-handed under stress — minimum height is 2× the system TAP_TARGET.
 *
 * This component is display-only: it fires onPress callbacks and the parent
 * (home screen) is responsible for navigation and state. No direct mesh calls.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Radius, Spacing, TAP_TARGET, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/i18n/provider';
import type { EmergencyCategory } from '@/lib/app-state';

type GridAction =
  | { kind: 'emergency'; category: EmergencyCategory }
  | { kind: 'heartbeat' };

type GridButton = {
  id: string;
  icon: string;
  label: string;
  sublabel?: string;
  action: GridAction;
  tone: 'danger' | 'ok' | 'caution';
  /** Takes full row width. Used for the "I'm safe" button. */
  wide?: boolean;
};

type Props = {
  onAction: (action: GridAction) => void;
  /** Categories that are currently in cooldown — shown disabled. */
  disabledCategories?: EmergencyCategory[];
};

export function EmergencyGrid({ onAction, disabledCategories = [] }: Props) {
  const t = useTheme();
  const { t: copy } = useI18n();

  const buttons: GridButton[] = [
    {
      id: 'safe',
      icon: '🟢',
      label: copy('emergency.iAmSafe'),
      action: { kind: 'heartbeat' },
      tone: 'ok',
      wide: true,
    },
    {
      id: 'medical',
      icon: '🏥',
      label: copy('emergency.medical'),
      action: { kind: 'emergency', category: 'medical' as EmergencyCategory },
      tone: 'danger',
    },
    {
      id: 'need_help',
      icon: '🆘',
      label: copy('emergency.needHelp'),
      action: { kind: 'emergency', category: 'need_help' as EmergencyCategory },
      tone: 'danger',
    },
    {
      id: 'unsafe',
      icon: '⚠️',
      label: copy('emergency.unsafe'),
      action: { kind: 'emergency', category: 'unsafe' as EmergencyCategory },
      tone: 'caution',
    },
    {
      id: 'lost_group',
      icon: '👥',
      label: copy('emergency.lostGroup'),
      action: { kind: 'emergency', category: 'lost_group' as EmergencyCategory },
      tone: 'caution',
    },
  ];

  return (
    <View style={styles.grid}>
      {buttons.map((btn) => {
        const isDisabled =
          btn.action.kind === 'emergency' &&
          disabledCategories.includes(btn.action.category);

        const toneColors = t.tone[btn.tone];

        return (
          <Pressable
            key={btn.id}
            accessibilityRole="button"
            accessibilityLabel={btn.label}
            accessibilityState={{ disabled: isDisabled }}
            disabled={isDisabled}
            onPress={() => onAction(btn.action)}
            style={[
              styles.button,
              btn.wide && styles.wideButton,
              {
                backgroundColor: isDisabled
                  ? t.surfaceRaised
                  : toneColors.fill,
                borderColor: isDisabled ? t.border : toneColors.edge,
              },
            ]}>
            {({ pressed }) => (
              <View
                style={[
                  styles.buttonInner,
                  { opacity: pressed ? 0.75 : isDisabled ? 0.45 : 1 },
                ]}>
                <Text style={styles.icon}>{btn.icon}</Text>
                <Text
                  style={[
                    Type.bodyStrong,
                    {
                      color: isDisabled ? t.textFaint : toneColors.onFill,
                      textAlign: 'center',
                      marginTop: Spacing.xs,
                    },
                  ]}
                  numberOfLines={2}>
                  {btn.label}
                </Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  button: {
    // Each button fills slightly less than half the row (gap accounts for the rest)
    flexBasis: '47.5%',
    flexGrow: 1,
    minHeight: TAP_TARGET * 2,
    borderRadius: Radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  wideButton: {
    // Full row
    flexBasis: '100%',
    minHeight: TAP_TARGET * 1.4,
  },
  buttonInner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.md,
  },
  icon: {
    fontSize: 28,
    lineHeight: 36,
  },
});

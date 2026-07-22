/**
 * Alert feed — displays merged emergency alerts from nearby devices.
 *
 * Design rules:
 *   - Every alert says "Reported by nearby user" — never claims certainty
 *   - Category icon + label are the primary signal — readable at a glance
 *   - Relative time (e.g. "2 min ago") keeps context without exposing a clock
 *   - Dismiss clears the alert from the UI without deleting the DB row
 *     (the row stays for dedup until the 15-minute sweep)
 *   - At most 5 alerts shown at once — a screen showing 20 simultaneous
 *     emergencies is not useful to a person under stress
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Radius, Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/i18n/provider';
import type { EmergencyAlert } from '@/lib/app-state';

const CATEGORY_ICONS: Record<string, string> = {
  medical: '🏥',
  unsafe: '⚠️',
  lost_group: '👥',
  need_help: '🆘',
};

const CATEGORY_KEYS: Record<string, string> = {
  medical: 'emergency.category.medical',
  unsafe: 'emergency.category.unsafe',
  lost_group: 'emergency.category.lost_group',
  need_help: 'emergency.category.need_help',
};

function relativeTime(firstSeen: number, now: number, copy: (k: string, p?: Record<string, string | number>) => string): string {
  const diffMs = now - firstSeen;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return copy('emergency.justNow');
  return copy(diffMin === 1 ? 'emergency.minutesAgo.one' : 'emergency.minutesAgo.other', {
    count: diffMin,
  });
}

type Props = {
  alerts: EmergencyAlert[];
  onDismiss: (id: string) => void;
};

export function AlertFeed({ alerts, onDismiss }: Props) {
  const t = useTheme();
  const { t: copy } = useI18n();
  const now = Date.now();

  // Show at most 5 alerts — cognitive limit under stress
  const visible = alerts.slice(0, 5);

  if (visible.length === 0) return null;

  return (
    <View style={styles.container}>
      {visible.map((alert) => {
        const icon = CATEGORY_ICONS[alert.category] ?? '🆘';
        const labelKey = CATEGORY_KEYS[alert.category];
        const label = labelKey ? copy(labelKey as any) : alert.category;
        const timeStr = relativeTime(alert.firstSeen, now, copy as any);
        const countStr = copy(
          alert.reportCount === 1
            ? 'emergency.reportCount.one'
            : 'emergency.reportCount.other',
          { count: alert.reportCount },
        );

        return (
          <View
            key={alert.id}
            style={[
              styles.alertRow,
              { backgroundColor: t.tone.danger.tint, borderColor: t.tone.danger.edge },
            ]}>
            {/* Left: icon + label */}
            <View style={styles.alertLeft}>
              <Text style={styles.alertIcon}>{icon}</Text>
              <View style={styles.alertText}>
                <Text style={[Type.bodyStrong, { color: t.tone.danger.fg }]}>
                  {label}
                </Text>
                <Text style={[Type.caption, { color: t.textMuted, marginTop: 2 }]}>
                  {countStr} · {timeStr}
                </Text>
                <Text style={[Type.caption, { color: t.textFaint, marginTop: 2 }]}>
                  {copy('emergency.trustNote')}
                </Text>
              </View>
            </View>

            {/* Right: dismiss button */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy('emergency.dismiss')}
              hitSlop={12}
              onPress={() => onDismiss(alert.id)}>
              {({ pressed }) => (
                <Text
                  style={[
                    Type.caption,
                    {
                      color: t.textFaint,
                      opacity: pressed ? 0.5 : 1,
                      paddingLeft: Spacing.md,
                    },
                  ]}>
                  ✕
                </Text>
              )}
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.xs,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  alertRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.md,
  },
  alertLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
  },
  alertIcon: {
    fontSize: 22,
    lineHeight: 28,
    marginTop: 2,
  },
  alertText: {
    flex: 1,
  },
});

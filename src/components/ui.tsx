/**
 * The whole component vocabulary.
 *
 * Kept deliberately small: every extra control is another thing to understand
 * under stress, and a screen built from a handful of known pieces is a screen
 * that behaves the same everywhere.
 *
 * Two rules are enforced here rather than left to call sites, because leaving
 * them to call sites is how they get lost:
 *
 *   - `Tag` will not render a colour without a word. Colour is never the only
 *     signal — it is the first thing to fail in direct sun and it fails
 *     entirely for a colour-blind user.
 *   - Everything pressable is at least TAP_TARGET tall. One-handed, under
 *     stress, possibly while moving.
 */

import { Children, forwardRef, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type TextInputProps,
  type ViewProps,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Radius, Spacing, TAP_TARGET, Type, type ToneColors, type ToneName } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/i18n/provider';

// ---------------------------------------------------------------------------
// Screen

/**
 * The standard page body. Exists so every screen inherits the same horizontal
 * rhythm and the same bottom inset instead of re-deriving them, which is what
 * made the old screens drift by a few points from one another.
 */
export function Screen({
  children,
  scroll = true,
  footer,
  contentStyle,
}: {
  children: ReactNode;
  scroll?: boolean;
  /** Pinned above the home indicator. Use for the one primary action. */
  footer?: ReactNode;
  contentStyle?: ViewProps['style'];
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();

  const padding = {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: insets.bottom + (footer ? TAP_TARGET + Spacing.xxl : Spacing.xxl),
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={[padding, contentStyle]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive">
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, padding, contentStyle]}>{children}</View>
      )}

      {footer && (
        <View
          style={[
            styles.footer,
            {
              backgroundColor: t.bg,
              borderColor: t.border,
              paddingBottom: insets.bottom + Spacing.md,
            },
          ]}>
          {footer}
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Button

type ButtonProps = PressableProps & {
  title: string;
  variant?: 'primary' | 'secondary' | 'danger' | 'quiet';
};

export function Button({ title, variant = 'primary', disabled, style, ...rest }: ButtonProps) {
  const t = useTheme();

  const bg =
    variant === 'primary'
      ? t.accentFill
      : variant === 'danger'
        ? t.tone.danger.fill
        : variant === 'secondary'
          ? t.surfaceRaised
          : 'transparent';

  const fg =
    variant === 'primary' || variant === 'danger'
      ? t.onAccentFill
      : variant === 'quiet'
        ? t.accent
        : t.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      style={(state) => [
        styles.button,
        {
          backgroundColor: bg,
          // Pressed feedback is opacity only. A scale or a bounce on the send
          // button would be one more thing moving on a screen someone is
          // trying to read quickly.
          opacity: disabled ? 0.4 : state.pressed ? 0.72 : 1,
        },
        typeof style === 'function' ? style(state) : style,
      ]}
      {...rest}>
      <Text style={[Type.bodyStrong, { color: fg }]} numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Input

export const Input = forwardRef<TextInput, TextInputProps>(function Input(props, ref) {
  const t = useTheme();
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={t.textMuted}
      // Off across the board: this text is not for a keyboard vendor's cloud.
      autoCorrect={false}
      autoCapitalize="none"
      spellCheck={false}
      {...props}
      style={[
        styles.input,
        { backgroundColor: t.surface, borderColor: t.border, color: t.text },
        props.style,
      ]}
    />
  );
});

/** Label + input + hint, as one unit, so the three never drift apart. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const t = useTheme();
  return (
    <View style={{ gap: Spacing.sm }}>
      <Text style={[Type.label, { color: t.textMuted }]}>{label.toUpperCase()}</Text>
      {children}
      {!!hint && <Text style={[Type.caption, { color: t.textMuted }]}>{hint}</Text>}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Containers

export function Card({ style, ...rest }: ViewProps) {
  const t = useTheme();
  return (
    <View
      style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }, style]}
      {...rest}
    />
  );
}

/**
 * A grouped list. Owns its own separators so screens stop hand-rolling
 * `{i > 0 && <Separator />}`, and so a list never ends up nested inside a card
 * inside another card.
 */
export function List({ children }: { children: ReactNode }) {
  const t = useTheme();
  const items = Array.isArray(children) ? children.filter(Boolean) : [children];

  return (
    <View style={[styles.list, { backgroundColor: t.surface, borderColor: t.border }]}>
      {Children.toArray(items).map((child, i) => (
        <View key={`item-${i}`}>
          {i > 0 && <View style={[styles.sep, { backgroundColor: t.border }]} />}
          {child}
        </View>
      ))}
    </View>
  );
}

export function Row({
  title,
  subtitle,
  tag,
  leading,
  onPress,
  accessibilityLabel,
  unread = 0,
}: {
  title: string;
  subtitle?: string;
  tag?: ReactNode;
  leading?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  unread?: number;
}) {
  const t = useTheme();
  const { plural } = useI18n();
  const hasUnread = unread > 0;
  const hasMeta = !!tag || hasUnread;
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      // Fold the count into the label so a screen reader announces it too.
      accessibilityLabel={
        hasUnread ? `${accessibilityLabel ?? title}. ${plural('a11y.unread', unread)}` : accessibilityLabel
      }
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed && onPress ? t.surfaceRaised : 'transparent' },
      ]}>
      {leading}
      <View style={{ flex: 1, gap: 3 }}>
        <Text
          style={[
            Type.bodyStrong,
            // Unread pulls the title to full strength and bold; a read row sits
            // one notch quieter, so the list scans as "these need me" first.
            { color: t.text, fontWeight: hasUnread ? '700' : '600' },
          ]}
          numberOfLines={1}>
          {title}
        </Text>
        {!!subtitle && (
          <Text
            style={[Type.caption, { color: hasUnread ? t.text : t.textMuted }]}
            numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      {/* Tag and unread share the right edge, so they are stacked in one
          right-aligned column rather than left to collide: the state pill on
          top, the count beneath it. A row never has to choose between them. */}
      {hasMeta && (
        <View style={styles.rowMeta}>
          {tag}
          {hasUnread && (
            <View style={[styles.unread, { backgroundColor: t.accentFill }]}>
              <Text style={[Type.micro, { color: t.onAccentFill }]}>
                {unread > 99 ? '99+' : unread}
              </Text>
            </View>
          )}
        </View>
      )}
    </Pressable>
  );
}

/**
 * The leading tile for a list row. Every list gets one, so rows share a common
 * left edge instead of some being indented by an avatar and others sitting
 * flush against the card — which is what made the home screen's lists read as
 * unrelated strips.
 *
 * Deliberately neutral, never colour-coded: a per-row hue would look like a
 * trust signal, and nothing about a row's colour tells you whether the room
 * behind it is private. The mark only says *what kind* of row this is — a
 * person or group's initial, a channel's #, or the broadcast radiate mark. No
 * padlock and no shield: two of these rooms are not private and a lock is a lie.
 */
export function Leading({
  kind,
  name,
}: {
  kind: 'person' | 'group' | 'channel' | 'broadcast';
  name?: string;
}) {
  const t = useTheme();
  const initial = (name?.trim().charAt(0) ?? '').toUpperCase() || '?';
  return (
    <View
      // Decorative — the name is right beside it in text.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.monogram, { backgroundColor: t.surfaceRaised, borderColor: t.border }]}>
      {kind === 'broadcast' ? (
        // A center dot inside a ring: "radiating outward" without an icon font,
        // and pointedly not a signal-strength or lock glyph.
        <View style={styles.radiate}>
          <View style={[styles.radiateRing, { borderColor: t.textMuted }]} />
          <View style={[styles.radiateDot, { backgroundColor: t.textMuted }]} />
        </View>
      ) : (
        <Text style={[Type.calloutStrong, { color: t.textMuted }]}>
          {kind === 'channel' ? '#' : initial}
        </Text>
      )}
    </View>
  );
}

/** Back-compat alias; a person's leading tile is just an initialled monogram. */
export function Monogram({ name }: { name: string }) {
  return <Leading kind="person" name={name} />;
}

// ---------------------------------------------------------------------------
// Status

/**
 * The colour-plus-word marker used wherever a state is shown.
 *
 * `label` is required and there is no icon-only variant, by design. Two of the
 * four conversation modes are not private, and a user who reads only the colour
 * would have to guess which. No padlocks: a padlock reads as "safe", and it
 * would be a lie on half this app's surface area.
 */
export function Tag({ tone, label }: { tone: ToneName; label: string }) {
  const t = useTheme();
  const c: ToneColors = t.tone[tone];
  return (
    <View style={[styles.tag, { backgroundColor: c.tint, borderColor: c.edge }]}>
      <View style={[styles.tagDot, { backgroundColor: c.fg }]} />
      <Text style={[Type.micro, { color: c.fg }]} numberOfLines={1}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

/**
 * A toned callout. `loud` swaps the quiet tint for a solid fill, which is how
 * public broadcast gets to be unmistakable while a merely-imperfect state
 * stays readable rather than screaming.
 */
export function Notice({
  tone,
  title,
  children,
  loud = false,
  style,
}: {
  tone: ToneName;
  title?: string;
  children?: ReactNode;
  loud?: boolean;
  style?: ViewProps['style'];
}) {
  const t = useTheme();
  const c = t.tone[tone];
  return (
    <View
      style={[
        styles.notice,
        {
          backgroundColor: loud ? c.fill : c.tint,
          borderColor: loud ? c.fill : c.edge,
        },
        style,
      ]}>
      {!!title && (
        <Text style={[Type.calloutStrong, { color: loud ? c.onFill : c.fg }]}>
          {title.toUpperCase()}
        </Text>
      )}
      {children}
    </View>
  );
}

/** The bulleted honest-limitations style used on Settings and Join channel. */
export function Bullets({ items, color }: { items: string[]; color?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: Spacing.sm }}>
      {items.map((line) => (
        <View key={line} style={{ flexDirection: 'row', gap: Spacing.sm }}>
          <Text style={[Type.callout, { color: color ?? t.textMuted }]}>—</Text>
          <Text style={[Type.callout, { color: color ?? t.textMuted, flex: 1 }]}>{line}</Text>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Structure

export function SectionHeader({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  const t = useTheme();
  const { t: copy } = useI18n();
  return (
    <View style={styles.sectionHeader}>
      <Text
        accessibilityRole="header"
        style={[Type.label, { color: t.textMuted }]}>
        {title.toUpperCase()}
      </Text>
      {!!action && !!onAction && (
        <Pressable
          // 20pt slop around a 16pt line clears the 52pt tap target the eyebrow
          // itself is too short to provide.
          hitSlop={20}
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={copy('a11y.sectionAction', { action, section: title })}>
          {({ pressed }) => (
            <Text style={[Type.label, { color: t.accent, opacity: pressed ? 0.6 : 1 }]}>
              {action.toUpperCase()}
            </Text>
          )}
        </Pressable>
      )}
    </View>
  );
}

/**
 * Empty states teach rather than apologise. Every one of these says what the
 * thing is for and what to do next, because the moment someone first opens
 * this app is very unlikely to be a calm one.
 */
export function Empty({
  title,
  detail,
  action,
  onAction,
  compact = false,
}: {
  title: string;
  detail: string;
  action?: string;
  onAction?: () => void;
  /**
   * Lighter and shorter, for an empty state stacked among others (the home
   * lists). Three full-size explanations in a row read as three essays; the
   * compact form keeps every word but drops the weight so an empty app looks
   * unstarted, not overwhelming. The standalone conversation empty stays full.
   */
  compact?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={[styles.empty, compact && styles.emptyCompact]}>
      <Text style={[compact ? Type.calloutStrong : Type.heading, { color: t.text, textAlign: 'center' }]}>
        {title}
      </Text>
      <Text
        style={[
          compact ? Type.caption : Type.callout,
          {
            color: t.textMuted,
            textAlign: 'center',
            maxWidth: compact ? 300 : 320,
            marginTop: compact ? Spacing.xs : Spacing.sm,
          },
        ]}>
        {detail}
      </Text>
      {!!action && !!onAction && (
        <Button
          title={action}
          variant="quiet"
          onPress={onAction}
          style={{ marginTop: compact ? Spacing.xs : Spacing.sm }}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  button: {
    minHeight: TAP_TARGET,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
  },
  input: {
    minHeight: TAP_TARGET,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    fontSize: Type.body.fontSize,
    lineHeight: Type.body.lineHeight,
  },
  card: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.lg,
  },
  list: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  // Inset to the row's text column, so a list reads as one block rather than
  // as a stack of unrelated strips.
  sep: { height: StyleSheet.hairlineWidth, marginLeft: Spacing.lg },
  row: {
    minHeight: TAP_TARGET + 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  // The right-hand meta column: state pill over unread count, both flushed to
  // the row's right edge so they line up down a list instead of colliding.
  rowMeta: {
    alignItems: 'flex-end',
    gap: Spacing.xs + 2,
  },
  unread: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monogram: {
    width: 40,
    height: 40,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radiate: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  radiateRing: {
    position: 'absolute',
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
  },
  radiateDot: { width: 6, height: 6, borderRadius: 3 },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs + 2,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tagDot: { width: 6, height: 6, borderRadius: 3 },
  notice: {
    borderRadius: Radius.lg,
    borderWidth: 1,
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    // The eyebrow hugs the card beneath it (small marginBottom) while a wide
    // gap opens above, so a header reads as belonging to the list it labels
    // rather than floating equidistant between two sections.
    minHeight: 24,
    marginTop: Spacing.xxl,
    marginBottom: Spacing.xs + 2,
    paddingHorizontal: Spacing.xs,
  },
  empty: {
    // Sized to sit comfortably inside a Card without doubling its padding, and
    // to still feel deliberate when used standalone in an empty conversation.
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.sm,
    alignItems: 'center',
  },
  emptyCompact: { paddingVertical: Spacing.sm },
});

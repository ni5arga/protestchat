/**
 * Describes what a conversation IS, in words a frightened person can parse.
 *
 * There are now three modes with three genuinely different threat models, and
 * the single most dangerous failure this app can have is someone typing
 * something into public broadcast believing it is private. So the mode is
 * derived in exactly one place, here, and every screen renders from it.
 *
 * Rules this encodes:
 *   - The warning is never optional and never collapsible.
 *   - Weaker confidentiality gets LOUDER treatment, not quieter.
 *   - No padlock iconography anywhere. A padlock means "safe" to most people,
 *     and two of these three modes are not safe in the way a padlock implies.
 */

import type { Channel, Group } from './db';
import type { Translator } from '@/i18n/core';

export type ConversationMode = 'public' | 'channel' | 'group' | 'direct';

export type ConversationInfo = {
  mode: ConversationMode;
  /** Human title for the header. */
  title: string;
  /** One line, always shown, never dismissible. */
  warning: string;
  /** 'danger' paints red, 'caution' amber, 'ok' green. */
  tone: 'danger' | 'caution' | 'ok';
  /** Whether other people's names should be shown against each message. */
  showSenders: boolean;
};

export function describeConversation(
  conversationId: string,
  ctx: { channels: Channel[]; groups: Group[]; contactName?: string; verified?: boolean },
  i18n: Translator,
): ConversationInfo {
  const { t, plural } = i18n;
  if (conversationId.startsWith('#')) {
    const id = conversationId.slice(1);
    const channel = ctx.channels.find((c) => c.id === id);

    if (channel?.kind === 'public') {
      return {
        mode: 'public',
        title: t('conversation.publicTitle'),
        // Blunt on purpose. "Not encrypted" means nothing to most people;
        // "police" is the concrete thing they are actually worried about.
        warning: t('conversation.publicWarning'),
        tone: 'danger',
        showSenders: true,
      };
    }

    return {
      mode: 'channel',
      title: `#${id}`,
      warning: t('conversation.channelWarning'),
      tone: 'caution',
      showSenders: true,
    };
  }

  if (conversationId.startsWith('~')) {
    const group = ctx.groups.find((g) => g.id === conversationId.slice(1));
    const n = group?.members.length ?? 0;
    return {
      mode: 'group',
      title: group?.name ?? t('common.group'),
      warning: plural('conversation.groupWarning', n),
      tone: 'ok',
      showSenders: true,
    };
  }

  return {
    mode: 'direct',
    title: ctx.contactName ?? t('common.chat'),
    warning: ctx.verified
      ? t('conversation.directVerified')
      : t('conversation.directUnverified'),
    tone: ctx.verified ? 'ok' : 'caution',
    showSenders: false,
  };
}

/**
 * Cap on closed-group size.
 *
 * Fan-out means an N-member group costs N envelopes per message on a radio
 * Google itself documents as low-bandwidth. This is a practical limit, not a
 * cryptographic one — raise it only after measuring on real hardware.
 */
export const MAX_GROUP_MEMBERS = 15;

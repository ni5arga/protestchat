/**
 * App-wide state: identity, radio status, contacts, conversations.
 *
 * Thin on purpose. All the interesting logic lives in mesh.ts; this exists to
 * get it into React and to keep the screens free of anything security-relevant.
 */

import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { RadioAccessGate } from '@/components/radio-access-gate';

import { cleanContactName } from './contact';
import type { Identity, PublicIdentity } from './crypto';
import {
  PUBLIC_CHANNEL_KEY,
  PUBLIC_CHANNEL_NAME,
  destroyIdentity,
  deriveChannelKey,
  loadOrCreateIdentity,
  normaliseChannelName,
  parsePublicId,
  randomId,
  safetyNumber,
} from './crypto';
import * as db from './db';
import type { MeshStatus } from './mesh';
import { mesh, shortName } from './mesh';

const NAME_KEY = 'protestchat.displayName.v1';

type AppContextValue = {
  ready: boolean;
  identity: Identity | null;
  displayName: string;
  setDisplayName: (name: string) => Promise<void>;

  status: MeshStatus;
  conversations: db.Conversation[];
  contacts: db.Contact[];
  channels: db.Channel[];
  groups: db.Group[];

  startRadio: () => Promise<void>;
  stopRadio: () => Promise<void>;

  /**
   * Sends to any conversation. The prefix decides the mode:
   *   "#id"  channel or public broadcast
   *   "~id"  closed group
   *   else   direct message to that publicId
   */
  sendText: (conversationId: string, text: string) => Promise<void>;

  joinChannel: (name: string, passphrase: string) => Promise<db.Channel>;
  leaveChannel: (id: string) => Promise<void>;
  createGroup: (name: string, memberPublicIds: string[]) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  addContact: (publicId: string, name?: string) => Promise<boolean>;
  renameContact: (publicId: string, name: string) => Promise<void>;
  verifyContact: (publicId: string, verified: boolean) => Promise<void>;
  safetyNumberFor: (publicId: string) => string | null;

  panicWipe: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AppContext = createContext<AppContextValue | null>(null);

const EMPTY_STATUS: MeshStatus = {
  running: false,
  radioAvailable: false,
  peers: [],
  connected: [],
  carrying: 0,
  lastError: null,
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [displayName, setName] = useState('anon');
  const [status, setStatus] = useState<MeshStatus>(EMPTY_STATUS);
  const [conversations, setConversations] = useState<db.Conversation[]>([]);
  const [contacts, setContacts] = useState<db.Contact[]>([]);
  const [channels, setChannels] = useState<db.Channel[]>([]);
  const [groups, setGroups] = useState<db.Group[]>([]);

  const identityRef = useRef<Identity | null>(null);

  const refresh = useCallback(async () => {
    const [convos, cts, chs, grps] = await Promise.all([
      db.listConversations(),
      db.listContacts(),
      db.listChannels(),
      db.listGroups(),
    ]);
    setConversations(convos);
    setContacts(cts);
    setChannels(chs);
    setGroups(grps);

    // The engine trial-decrypts against whatever we hand it here, so this must
    // run after any join or leave or those messages become unreadable.
    mesh.setChannelKeys(chs.map((c) => ({ id: c.id, key: c.key })));
  }, []);

  // ---- boot -------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      await db.getDb();
      await db.sweepExpired();

      // Public broadcast always exists and cannot be left. Its key is a
      // hardcoded constant every install shares — it provides no
      // confidentiality and the UI must say so loudly.
      await db.upsertChannel(PUBLIC_CHANNEL_NAME, PUBLIC_CHANNEL_NAME, 'public', PUBLIC_CHANNEL_KEY);

      const id = await loadOrCreateIdentity();
      const storedName = await SecureStore.getItemAsync(NAME_KEY);
      const name = storedName ?? shortName(id.publicId);
      if (!storedName) await SecureStore.setItemAsync(NAME_KEY, name);

      if (cancelled) return;
      identityRef.current = id;
      setIdentity(id);
      setName(name);
      await refresh();
      setReady(true);
    })();

    const unsub = mesh.subscribe(setStatus);
    mesh.onMessage = () => void refresh();

    return () => {
      cancelled = true;
      unsub();
      mesh.onMessage = null;
    };
  }, [refresh]);

  // ---- expire on every foreground ---------------------------------------
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void db.sweepExpired().then(refresh);
    });
    return () => sub.remove();
  }, [refresh]);

  // ---- actions ----------------------------------------------------------

  const setDisplayName = useCallback(async (name: string) => {
    const trimmed = name.trim().slice(0, 32) || 'anon';
    await SecureStore.setItemAsync(NAME_KEY, trimmed);
    setName(trimmed);
  }, []);

  const startRadio = useCallback(async () => {
    if (identityRef.current) await mesh.start(identityRef.current, displayName).catch(() => {});
  }, [displayName]);

  const stopRadio = useCallback(() => mesh.stop(), []);

  const sendText = useCallback(
    async (conversationId: string, text: string) => {
      if (conversationId.startsWith('#')) {
        const channel = channels.find((c) => c.id === conversationId.slice(1));
        if (!channel) throw new Error('You are not in that channel any more.');
        await mesh.sendToChannel(channel.id, channel.key, text);
      } else if (conversationId.startsWith('~')) {
        const group = groups.find((g) => g.id === conversationId.slice(1));
        if (!group) throw new Error('That group no longer exists.');

        const members = group.members
          .map(parsePublicId)
          .filter((m): m is PublicIdentity => m !== null);
        if (members.length === 0) throw new Error('That group has no valid members.');

        await mesh.sendToGroup(group.id, members, text);
      } else {
        const recipient = parsePublicId(conversationId);
        if (!recipient) throw new Error('That contact code is not valid.');
        await mesh.sendText(recipient, text);
      }
      await refresh();
    },
    [refresh, channels, groups],
  );

  /**
   * Joins a channel, deriving its key from the name and passphrase.
   *
   * Deliberately slow (~200ms on a phone) — see SCRYPT_PARAMS. The key is
   * cached in SQLite afterwards, so this cost is paid once per channel, never
   * per message.
   */
  const joinChannel = useCallback(
    async (name: string, passphrase: string) => {
      const id = normaliseChannelName(name);
      if (!id) throw new Error('Give the channel a name.');
      if (!passphrase) throw new Error('A channel needs a passphrase.');

      const key = deriveChannelKey(id, passphrase);
      await db.upsertChannel(id, id, 'channel', key);
      await refresh();

      return { id, name: id, kind: 'channel' as const, key, joinedAt: Date.now() };
    },
    [refresh],
  );

  const leaveChannel = useCallback(
    async (id: string) => {
      await db.leaveChannel(id);
      await refresh();
    },
    [refresh],
  );

  const createGroup = useCallback(
    async (name: string, memberPublicIds: string[]) => {
      await db.createGroup(randomId(), name.trim() || 'group', memberPublicIds);
      await refresh();
    },
    [refresh],
  );

  const deleteGroup = useCallback(
    async (id: string) => {
      await db.deleteGroup(id);
      await refresh();
    },
    [refresh],
  );

  const addContact = useCallback(
    async (publicId: string, name?: string) => {
      const parsed = parsePublicId(publicId.trim());
      if (!parsed) return false;
      const chosen = name ? cleanContactName(name) : null;
      await db.upsertContact(parsed.publicId, chosen || shortName(parsed.publicId));
      // upsertContact deliberately will not overwrite an existing name, so a
      // deliberate rename needs the explicit path.
      if (chosen) await db.setContactName(parsed.publicId, chosen);
      await refresh();
      return true;
    },
    [refresh],
  );

  const renameContact = useCallback(
    async (publicId: string, name: string) => {
      const chosen = cleanContactName(name);
      if (!chosen) throw new Error('Give this person a name.');
      if (!(await db.getContact(publicId))) {
        throw new Error('That person is no longer on this phone.');
      }
      await db.setContactName(publicId, chosen);
      await refresh();
    },
    [refresh],
  );

  const verifyContact = useCallback(
    async (publicId: string, verified: boolean) => {
      await db.setContactVerified(publicId, verified);
      await refresh();
    },
    [refresh],
  );

  const safetyNumberFor = useCallback(
    (publicId: string) => {
      const them: PublicIdentity | null = parsePublicId(publicId);
      if (!them || !identity) return null;
      return safetyNumber(identity, them);
    },
    [identity],
  );

  const panicWipe = useCallback(async () => {
    await mesh.stop();
    await db.wipeEverything();
    await destroyIdentity();
    await SecureStore.deleteItemAsync(NAME_KEY);

    // Come back up as a brand new person. Leaving the app in a dead state
    // would itself be a signal that something was wiped.
    await db.upsertChannel(PUBLIC_CHANNEL_NAME, PUBLIC_CHANNEL_NAME, 'public', PUBLIC_CHANNEL_KEY);
    const fresh = await loadOrCreateIdentity();
    const freshName = shortName(fresh.publicId);
    await SecureStore.setItemAsync(NAME_KEY, freshName);
    identityRef.current = fresh;
    setIdentity(fresh);
    setName(freshName);
    await refresh();
    await mesh.start(fresh, freshName).catch(() => {});
  }, [refresh]);

  const value = useMemo<AppContextValue>(
    () => ({
      ready,
      identity,
      displayName,
      setDisplayName,
      status,
      conversations,
      contacts,
      channels,
      groups,
      startRadio,
      stopRadio,
      sendText,
      joinChannel,
      leaveChannel,
      createGroup,
      deleteGroup,
      addContact,
      renameContact,
      verifyContact,
      safetyNumberFor,
      panicWipe,
      refresh,
    }),
    [
      ready,
      identity,
      displayName,
      setDisplayName,
      status,
      conversations,
      contacts,
      channels,
      groups,
      startRadio,
      stopRadio,
      sendText,
      joinChannel,
      leaveChannel,
      createGroup,
      deleteGroup,
      addContact,
      renameContact,
      verifyContact,
      safetyNumberFor,
      panicWipe,
      refresh,
    ],
  );

  return (
    <AppContext.Provider value={value}>
      <RadioAccessGate appReady={ready} startRadio={startRadio}>
        {children}
      </RadioAccessGate>
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}

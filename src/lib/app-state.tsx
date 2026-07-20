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
import { encodeContactCode, decodeContactCode } from './contact-code';
import type { Identity, PublicIdentity } from './crypto';
import {
  PUBLIC_CHANNEL_KEY,
  PUBLIC_CHANNEL_NAME,
  RECEIVE_KEY_ROTATION_MS,
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
import { LocalPrekeys, PeerPrekeyBook } from './prekeys';

const NAME_KEY = 'protestchat.displayName.v1';

type AppContextValue = {
  ready: boolean;
  identity: Identity | null;
  displayName: string;
  setDisplayName: (name: string) => Promise<void>;

  /**
   * Current contact code for the QR plaque (v2 with prekey bundle when ready).
   * Empty until boot finishes.
   */
  contactCode: string;

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
  /** Accepts a raw QR/paste string (v1 or v2 contact code) or a bare publicId. */
  addContact: (codeOrPublicId: string, name?: string) => Promise<boolean>;
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
  const [contactCode, setContactCode] = useState('');

  const identityRef = useRef<Identity | null>(null);
  const localPrekeysRef = useRef(new LocalPrekeys());
  const peerPrekeysRef = useRef(new PeerPrekeyBook());

  const persistPrekeys = useCallback(async (id: Identity) => {
    const local = localPrekeysRef.current;
    local.ensureReady();
    const snap = local.snapshot();
    await db.saveLocalPrekeys(snap.spk, snap.otks);
    await db.savePeerPrekeys(peerPrekeysRef.current.snapshot());
    mesh.setLocalPrekeys(local);
    mesh.setPeerPrekeys(peerPrekeysRef.current);
    const bundle = local.bundleForQr(id);
    setContactCode(encodeContactCode(id.publicId, bundle));
    // bundleForQr is SPK-only, but ensureReady/fillPool may have minted keys.
    const after = local.snapshot();
    await db.saveLocalPrekeys(after.spk, after.otks);
  }, []);

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

    mesh.setChannelKeys(chs.map((c) => ({ id: c.id, key: c.key })));
  }, []);

  // ---- boot -------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      await db.getDb();
      await db.sweepExpired();

      await db.upsertChannel(PUBLIC_CHANNEL_NAME, PUBLIC_CHANNEL_NAME, 'public', PUBLIC_CHANNEL_KEY);

      const id = await loadOrCreateIdentity();
      const storedName = await SecureStore.getItemAsync(NAME_KEY);
      const name = storedName ?? shortName(id.publicId);
      if (!storedName) await SecureStore.setItemAsync(NAME_KEY, name);

      const stored = await db.loadLocalPrekeys();
      localPrekeysRef.current.load(stored.spk, stored.otks);
      peerPrekeysRef.current.load(await db.loadPeerPrekeys());

      if (cancelled) return;
      identityRef.current = id;
      setIdentity(id);
      setName(name);

      mesh.onPrekeysChanged = () => {
        const cur = identityRef.current;
        if (cur) void persistPrekeys(cur);
      };

      await persistPrekeys(id);
      await refresh();
      setReady(true);
      // NB: the mesh is NOT started here. The RadioAccessGate (#23) owns that —
      // it calls startRadio() only once Bluetooth permission and power are
      // ready, so the radio never comes up behind a denied/off gate.
    })();

    const unsub = mesh.subscribe(setStatus);
    mesh.onMessage = () => void refresh();

    return () => {
      cancelled = true;
      unsub();
      mesh.onMessage = null;
      mesh.onPrekeysChanged = null;
    };
  }, [refresh, persistPrekeys]);

  // ---- expire + rotate on foreground and on a timer ---------------------
  useEffect(() => {
    const syncKeys = () => {
      const id = identityRef.current;
      if (!id) return;
      void db
        .sweepExpired()
        .then(() => persistPrekeys(id))
        .then(refresh);
    };

    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') syncKeys();
    });
    const timer = setInterval(syncKeys, Math.min(RECEIVE_KEY_ROTATION_MS, 60_000));
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [refresh, persistPrekeys]);

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
    async (codeOrPublicId: string, name?: string) => {
      const parsed = decodeContactCode(codeOrPublicId);
      if (!parsed) return false;
      const chosen = name ? cleanContactName(name) : null;
      await db.upsertContact(
        parsed.identity.publicId,
        chosen || shortName(parsed.identity.publicId),
      );
      // upsertContact deliberately will not overwrite an existing name, so a
      // deliberate rename needs the explicit path.
      if (chosen) await db.setContactName(parsed.identity.publicId, chosen);
      if (parsed.bundle) {
        peerPrekeysRef.current.absorb(parsed.identity, parsed.bundle);
        mesh.setPeerPrekeys(peerPrekeysRef.current);
        await db.savePeerPrekeys(peerPrekeysRef.current.snapshot());
      }
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
    // This runs at the worst possible moment on a possibly-degraded device, so
    // no single step may be allowed to block the others, and a wipe that did
    // not fully complete must never look like one that did.
    //
    // Order is by blast radius: the identity seed decrypts all recorded past
    // direct traffic, so it goes first and unconditionally — before the radio,
    // which can hang, and before the database, which can partially fail. Each
    // destructive step is independent and best-effort; failures are collected
    // and surfaced rather than swallowed as an unhandled rejection.
    const failures: string[] = [];
    const wipeStep = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        failures.push(`${label} (${err instanceof Error ? err.message : String(err)})`);
      }
    };

    await wipeStep('identity seed', () => destroyIdentity());
    await wipeStep('display name', () => SecureStore.deleteItemAsync(NAME_KEY));
    await wipeStep('messages and keys', () => db.wipeEverything());
    // A live radio keeps re-deriving state from the identity we just destroyed,
    // so quiet it — but only after the durable secrets are gone, since stop()
    // is the step most likely to hang on a wedged BLE stack.
    await wipeStep('radio', () => mesh.stop());

    // Drop in-memory secrets regardless of what threw above.
    identityRef.current = null;
    setIdentity(null);
    localPrekeysRef.current = new LocalPrekeys();
    peerPrekeysRef.current = new PeerPrekeyBook();
    mesh.setPeerPrekeys(peerPrekeysRef.current);

    // Do not re-provision on top of a half-wiped device, and do not let the UI
    // report success. Leaving the app with no identity is the honest state.
    if (failures.length > 0) {
      throw new Error(`This phone may not be fully wiped — ${failures.join(', ')}.`);
    }

    // The device is verifiably clean: hand the user a fresh identity so the app
    // is usable again. A failure here is a provisioning problem, not a wipe that
    // leaked, so it surfaces on its own.
    await db.upsertChannel(PUBLIC_CHANNEL_NAME, PUBLIC_CHANNEL_NAME, 'public', PUBLIC_CHANNEL_KEY);
    const fresh = await loadOrCreateIdentity();
    const freshName = shortName(fresh.publicId);
    await SecureStore.setItemAsync(NAME_KEY, freshName);
    identityRef.current = fresh;
    setIdentity(fresh);
    setName(freshName);
    await persistPrekeys(fresh);
    await refresh();
    await mesh.start(fresh, freshName).catch(() => {});
  }, [refresh, persistPrekeys]);

  const value = useMemo<AppContextValue>(
    () => ({
      ready,
      identity,
      displayName,
      setDisplayName,
      contactCode,
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
      contactCode,
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

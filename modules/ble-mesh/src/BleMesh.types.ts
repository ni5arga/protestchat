/**
 * Type contract for the `BleMesh` native module.
 *
 * The native layer is a *dumb byte pipe*. It carries no chat logic: no message
 * parsing, no dedup, no storage, no crypto. Binary payloads cross the bridge as
 * base64 strings and come back out of the other device byte-for-byte identical.
 *
 * The one thing it does above raw ATT writes is *framing* — splitting a payload
 * into MTU-sized chunks and putting it back together. That is transport plumbing,
 * not chat logic: see the note on `send` and the README for why it lives here and
 * not in TypeScript.
 */

/**
 * Opaque, per-session peer handle. Minted locally by the native module.
 *
 * This is NOT an identity. It is not stable across app restarts, not stable
 * across the remote peer's identifier rotation, and carries no relationship to
 * the peer's public key or display name. Peer identity is established by the
 * sealed payloads at the mesh layer; the transport deliberately knows nothing
 * about who it is talking to.
 */
export type PeerId = string;

// ---------------------------------------------------------------------------
// Radio state
// ---------------------------------------------------------------------------

/**
 * Why the radio is or is not usable. The two failure modes a user can actually
 * fix are deliberately distinct: "Bluetooth is switched off" and "you said no to
 * the permission prompt" need completely different instructions, and collapsing
 * them into a single "radio unavailable" is how people end up standing in a
 * jammed square tapping a button that will never work.
 */
export type BleState =
  /** Powered on, permissions granted, advertising and scanning are possible. */
  | 'ready'
  /** The user switched Bluetooth off at the OS level. */
  | 'poweredOff'
  /** Permission denied — Android runtime permissions, or iOS Bluetooth privacy. */
  | 'unauthorized'
  /** Android 11 and older: Location Services is off, so BLE scans return nothing. */
  | 'locationOff'
  /** No BLE hardware, or no peripheral (advertising) role support. */
  | 'unsupported'
  /** The stack is restarting; transient, wait for the next state change. */
  | 'resetting'
  /** Not yet determined — CoreBluetooth reports this before its first callback. */
  | 'unknown';

export type BleStatus = {
  state: BleState;
  /** True only when `state === 'ready'`. */
  available: boolean;
  /** Human-readable detail, safe to show a user. Empty when `ready`. */
  message: string;
};

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

/**
 * A device advertising our service UUID was seen. Not connected yet.
 *
 * `name` is always the empty string. It exists solely so this event is
 * structurally identical to the `Peer` shape the TS `Transport` interface
 * expects. **Nothing about the user is ever advertised** — see README.
 */
export type PeerFoundEvent = {
  id: PeerId;
  name: '';
};

/** No advertisement from this peer for `PEER_STALE_MS`. Advisory, not authoritative. */
export type PeerLostEvent = {
  id: PeerId;
};

/**
 * A GATT link is up, MTU is negotiated, HELLO has been exchanged, and duplicate
 * links have been resolved. `send()` to this peer is valid from here until
 * `onDisconnected`.
 */
export type ConnectedEvent = {
  id: PeerId;
  name: '';
  /**
   * Usable payload bytes per ATT write, after protocol overhead but before our
   * 8-byte chunk header. Reported for diagnostics only — chunking is already
   * done for you.
   */
  mtu: number;
  /** `true` when the remote side connected to our GATT server. */
  isIncoming: boolean;
};

/** The link is gone. Emitted exactly once per `onConnected`. */
export type DisconnectedEvent = {
  id: PeerId;
};

/** A *fully reassembled* payload arrived. Partial messages never surface here. */
export type PayloadEvent = {
  peerId: PeerId;
  /** Standard base64 (RFC 4648), no line wrapping. */
  payloadBase64: string;
};

/** The Bluetooth adapter's state changed, including the first determination. */
export type StateChangeEvent = BleStatus;

/**
 * Something failed. Emitted *in addition to* the rejected promise when the
 * failure originates from a call, and on its own for asynchronous radio failures
 * that belong to no particular call.
 */
export type ErrorEvent = {
  message: string;
  /** Coded error identifier, e.g. `ERR_BLE_POWERED_OFF`. */
  code: string;
};

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

export type BleMeshEvents = {
  onPeerFound: (event: PeerFoundEvent) => void;
  onPeerLost: (event: PeerLostEvent) => void;
  onConnected: (event: ConnectedEvent) => void;
  onDisconnected: (event: DisconnectedEvent) => void;
  onPayload: (event: PayloadEvent) => void;
  onStateChange: (event: StateChangeEvent) => void;
  onError: (event: ErrorEvent) => void;
};

export type BleMeshEventName = keyof BleMeshEvents;

// ---------------------------------------------------------------------------
// Module surface
// ---------------------------------------------------------------------------

export type BleMeshApi = {
  /**
   * Starts the GATT server and begins advertising the service UUID plus a fresh
   * ephemeral tag, and starts the rotation timer.
   *
   * `rotationMs` overrides `DEFAULT_ROTATION_MS`; pass 0 to use the default.
   * There is no display-name parameter and there never will be one.
   */
  startAdvertising(rotationMs: number): Promise<void>;

  /** Starts scanning for peers advertising the service UUID. */
  startScanning(): Promise<void>;

  /**
   * Stops advertising and scanning, tears down every link, clears every
   * reassembly buffer, and stops the rotation timer. Always resolves.
   */
  stopAll(): Promise<void>;

  /**
   * Opens a GATT link to a discovered peer. Resolves when the connection attempt
   * is issued, not when it completes — wait for `onConnected`.
   *
   * Safe to call for a peer we are already connected to or already connecting
   * to; it is a no-op success in both cases. That matters because both devices
   * will typically call it about each other at the same moment.
   */
  connect(peerId: PeerId): Promise<void>;

  /** Drops a link. No-op success if the peer is already gone. */
  disconnect(peerId: PeerId): Promise<void>;

  /**
   * Sends one whole payload to one connected peer.
   *
   * **Chunking happens natively, below this call.** The payload is split across
   * as many ATT operations as the negotiated MTU requires and reassembled by the
   * peer before it surfaces as a single `onPayload`. Resolves when the last
   * chunk has been handed to the OS, which is not a delivery guarantee.
   */
  send(peerId: PeerId, payloadBase64: string): Promise<void>;

  /** Current adapter state, without waiting for an event. */
  getStatus(): Promise<BleStatus>;

  /**
   * Requests the permissions required by this OS and presents any system UI
   * needed to turn the radio on. The returned state may still be non-ready when
   * the user must finish the action in system UI; observe `onStateChange`.
   */
  requestAccess(): Promise<BleStatus>;

  /** Convenience for `getStatus().state === 'ready'`. */
  isAvailable(): Promise<boolean>;

  /**
   * Forces an immediate identifier rotation. Exposed for tests and for a panic
   * wipe, which must not leave the old tag on the air.
   */
  rotateNow(): Promise<void>;
};

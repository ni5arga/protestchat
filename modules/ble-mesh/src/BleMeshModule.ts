import { NativeModule, requireNativeModule, type EventSubscription } from 'expo-modules-core';

import type {
  BleMeshApi,
  BleMeshEvents,
  BleStatus,
  ConnectedEvent,
  DisconnectedEvent,
  ErrorEvent,
  PayloadEvent,
  PeerFoundEvent,
  PeerId,
  PeerLostEvent,
  StateChangeEvent,
} from './BleMesh.types';

declare class BleMeshNativeModule extends NativeModule<BleMeshEvents> implements BleMeshApi {
  startAdvertising(rotationMs: number): Promise<void>;
  startScanning(): Promise<void>;
  stopAll(): Promise<void>;
  connect(peerId: PeerId): Promise<void>;
  disconnect(peerId: PeerId): Promise<void>;
  send(peerId: PeerId, payloadBase64: string): Promise<void>;
  getStatus(): Promise<BleStatus>;
  requestAccess(): Promise<BleStatus>;
  isAvailable(): Promise<boolean>;
  rotateNow(): Promise<void>;
}

const BleMesh = requireNativeModule<BleMeshNativeModule>('BleMesh');

export default BleMesh;

// ---------------------------------------------------------------------------
// Typed event subscription helpers
// ---------------------------------------------------------------------------

export function addPeerFoundListener(
  listener: (event: PeerFoundEvent) => void,
): EventSubscription {
  return BleMesh.addListener('onPeerFound', listener);
}

export function addPeerLostListener(listener: (event: PeerLostEvent) => void): EventSubscription {
  return BleMesh.addListener('onPeerLost', listener);
}

export function addConnectedListener(listener: (event: ConnectedEvent) => void): EventSubscription {
  return BleMesh.addListener('onConnected', listener);
}

export function addDisconnectedListener(
  listener: (event: DisconnectedEvent) => void,
): EventSubscription {
  return BleMesh.addListener('onDisconnected', listener);
}

export function addPayloadListener(listener: (event: PayloadEvent) => void): EventSubscription {
  return BleMesh.addListener('onPayload', listener);
}

export function addStateChangeListener(
  listener: (event: StateChangeEvent) => void,
): EventSubscription {
  return BleMesh.addListener('onStateChange', listener);
}

export function addErrorListener(listener: (event: ErrorEvent) => void): EventSubscription {
  return BleMesh.addListener('onError', listener);
}

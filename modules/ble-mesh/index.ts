/**
 * ble-mesh — our own cross-platform BLE transport: CoreBluetooth on iOS, the
 * Android BLE GATT stack on Android. No Google Nearby, no Play services, no
 * Wi-Fi, no infrastructure of any kind.
 *
 * Why this exists rather than `modules/nearby-mesh`:
 *
 *   1. Nearby on iOS supports only the Wi-Fi LAN medium — both phones have to be
 *      on the same Wi-Fi network. At a protest with no infrastructure that is
 *      useless, and Google has never shipped iOS BLE for Nearby.
 *   2. Nearby gives no control over its advertising identifier, which is open
 *      problem #2 in docs/THREAT-MODEL.md. A stable BLE identifier is a tracking
 *      beacon. Here we own the advertisement and rotate it.
 *
 * This module is a transport only. It moves opaque byte blobs between nearby
 * devices and reports peer/link lifecycle. It has no knowledge of messages,
 * ordering, dedup, persistence or encryption — layer all of that on top in JS.
 */

import type { PeerId } from './src/BleMesh.types';
import BleMesh from './src/BleMeshModule';

export * from './src/BleMesh.types';
export * from './src/constants';

export {
  addConnectedListener,
  addDisconnectedListener,
  addErrorListener,
  addPayloadListener,
  addPeerFoundListener,
  addPeerLostListener,
  addStateChangeListener,
} from './src/BleMeshModule';

export { BleMesh };

/**
 * Starts the GATT server, begins advertising, and starts the rotation timer.
 * Pass 0 for `rotationMs` to use the 15-minute default.
 */
export function startAdvertising(rotationMs = 0): Promise<void> {
  return BleMesh.startAdvertising(rotationMs);
}

/** Starts scanning for peers advertising our service UUID. */
export function startScanning(): Promise<void> {
  return BleMesh.startScanning();
}

/** Stops everything and tears down all links and reassembly state. */
export function stopAll(): Promise<void> {
  return BleMesh.stopAll();
}

/** Opens a GATT link to a discovered peer. Idempotent. */
export function connect(peerId: PeerId): Promise<void> {
  return BleMesh.connect(peerId);
}

/** Drops a link. Safe on an already-gone peer. */
export function disconnect(peerId: PeerId): Promise<void> {
  return BleMesh.disconnect(peerId);
}

/** Sends base64-encoded bytes to a connected peer. Chunked natively. */
export function send(peerId: PeerId, payloadBase64: string): Promise<void> {
  return BleMesh.send(peerId, payloadBase64);
}

/** Adapter state, distinguishing powered-off from permission-denied. */
export function getStatus() {
  return BleMesh.getStatus();
}

/** Requests the OS permissions and presents controls needed to enable BLE. */
export function requestAccess() {
  return BleMesh.requestAccess();
}

/** Whether the BLE transport can run on this device right now. */
export function isAvailable(): Promise<boolean> {
  return BleMesh.isAvailable();
}

/** Forces an immediate identifier rotation (panic wipe, tests). */
export function rotateNow(): Promise<void> {
  return BleMesh.rotateNow();
}

export default BleMesh;

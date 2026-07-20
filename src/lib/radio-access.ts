import { Linking, Platform } from 'react-native';

import type { BleStatus, StateChangeEvent } from '../../modules/ble-mesh/src/BleMesh.types';

type RadioModule = {
  getStatus(): Promise<BleStatus>;
  requestAccess(): Promise<BleStatus>;
  addStateChangeListener(listener: (status: StateChangeEvent) => void): { remove(): void };
};

let cachedModule: RadioModule | null | undefined;

function getModule(): RadioModule | null {
  if (cachedModule !== undefined) return cachedModule;
  if (Platform.OS === 'web') return (cachedModule = null);

  try {
    // Keep this lazy: importing the native module at startup crashes Expo Go,
    // web, and any build made without the local BLE module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require('../../modules/ble-mesh') as RadioModule;
    cachedModule =
      typeof module.getStatus === 'function' && typeof module.requestAccess === 'function'
        ? module
        : null;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

const UNAVAILABLE: BleStatus = {
  state: 'unsupported',
  available: false,
  message: 'This build cannot use the Bluetooth mesh. Install it on a supported phone.',
};

export async function getRadioAccessStatus(): Promise<BleStatus> {
  return (await getModule()?.getStatus()) ?? UNAVAILABLE;
}

export async function requestRadioAccess(): Promise<BleStatus> {
  return (await getModule()?.requestAccess()) ?? UNAVAILABLE;
}

export function subscribeToRadioAccess(listener: (status: BleStatus) => void): () => void {
  const subscription = getModule()?.addStateChangeListener(listener);
  return () => subscription?.remove();
}

export function openAppSettings(): Promise<void> {
  return Linking.openSettings();
}

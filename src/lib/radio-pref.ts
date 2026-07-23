/**
 * Auto-start the mesh only when BLE is ready AND the user has not deliberately
 * turned Mesh Radio off in Settings (#71). Foreground/BLE events must not
 * override that choice.
 *
 * Kept free of react-native imports so node tests can cover the gate.
 */
export function shouldAutoStartRadio(bleReady: boolean, userEnabled: boolean): boolean {
  return bleReady && userEnabled;
}

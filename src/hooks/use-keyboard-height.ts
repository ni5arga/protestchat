import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * The keyboard's height, or 0 when hidden.
 *
 * We compute this ourselves rather than lean on KeyboardAvoidingView because
 * this app runs edge-to-edge (see react-native-is-edge-to-edge): the Android
 * window does NOT resize when the IME opens, it reports the keyboard as a window
 * inset instead. KeyboardAvoidingView's default Android path waits for a resize
 * that never comes, so the composer sat under the keyboard. The JS Keyboard
 * events fire with the real height regardless of edge-to-edge, on both
 * platforms, which makes this the reliable signal.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    // `will` on iOS rides the same animation curve as the keyboard; Android
    // only emits `did`.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const show = Keyboard.addListener(showEvent, (e) => setHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvent, () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return height;
}

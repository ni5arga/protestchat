import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Colors, Type } from '@/constants/theme';
import { useIsDark } from '@/hooks/use-theme';
import { AppProvider } from '@/lib/app-state';

export default function RootLayout() {
  const isDark = useIsDark();
  const t = isDark ? Colors.dark : Colors.light;

  return (
    <SafeAreaProvider>
      {/* KeyboardProvider reads the real IME window-inset animation natively.
          Under Android edge-to-edge the window does not resize and the RN
          Keyboard JS events do not reliably report the IME, so this is the only
          thing that actually moves the composer above the keyboard. */}
      <KeyboardProvider>
        <AppProvider>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: t.bg },
            headerTintColor: t.accent,
            headerTitleStyle: {
              color: t.text,
              fontSize: Type.heading.fontSize,
              fontWeight: Type.heading.fontWeight,
            },
            // No hairline under the header. The one horizontal rule that matters
            // on a chat screen is the bottom of the mode warning, and a second
            // rule directly above it dilutes that.
            headerShadowVisible: false,
            contentStyle: { backgroundColor: t.bg },
            // Calm and fast. The default push is already restrained; the point
            // here is that nothing anywhere in this app slides in playfully.
            animation: 'slide_from_right',
            animationDuration: 220,
          }}>
          {/* Home draws its own header so the status banner can be the first
              thing on the screen rather than the second. */}
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="chat/[id]" options={{ title: '' }} />
          <Stack.Screen name="contact/[id]" options={{ title: 'Edit person' }} />
          <Stack.Screen
            name="add"
            options={{ title: 'Add a person', presentation: 'modal', animation: 'slide_from_bottom' }}
          />
          <Stack.Screen name="verify/[id]" options={{ title: 'Verify' }} />
          <Stack.Screen
            name="join-channel"
            options={{ title: 'Join a channel', presentation: 'modal', animation: 'slide_from_bottom' }}
          />
          <Stack.Screen
            name="new-group"
            options={{ title: 'New group', presentation: 'modal', animation: 'slide_from_bottom' }}
          />
          <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        </Stack>
        </AppProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}

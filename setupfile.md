# ProtestChat: Emergency Coordination System Testing Guide

This document explains how to set up, run, and test the new offline emergency coordination features.

## 1. Prerequisites for Testing

Because this is a Bluetooth mesh communication app, **you cannot fully test it on a single simulator**. You need at least two instances running.

**Best testing setup:**
- Two physical iOS/Android devices.
- Bluetooth enabled on both.

**Alternative (Simulators):**
- Some limited mesh testing can be done with two simulators if the transport layer has a local mock/TCP fallback (depending on the `expo-mesh` implementation), but Bluetooth strictly requires physical devices for real-world verification.

## 2. Running the App

Start the Expo development server:
```bash
npm install
npx expo start
```
Scan the QR code with the Expo Go app on two different physical phones.

## 3. Testing the Emergency Flow End-to-End

### Test A: Sending a Medical Emergency
1. On **Phone A** and **Phone B**, open the app. Accept Bluetooth permissions if prompted.
2. Verify both phones show the green "Connected" or "Radio Active" status in the top Status Banner.
3. On **Phone A**, look at the new **EMERGENCY** grid on the Home screen.
4. Tap the red **Medical** (🏥) button.
5. A modal (`/emergency/sos`) will slide up. It says "Send Emergency Alert" and "Medical emergency".
6. **Press and hold** the large SOS button in the center. A ring will expand. Hold for **1.5 seconds** until it turns green and says "Alert sent".
7. The modal will auto-close after 2 seconds.
8. On **Phone A**, the Medical button on the home screen will now be grayed out (rate-limited for 5 minutes).

### Test B: Receiving the Alert
1. Look at **Phone B**.
2. At the top of the Home screen, a red alert should appear in the **NEARBY ALERTS** feed:
   - Icon: 🏥
   - Title: "Medical emergency"
   - Subtitle: "1 person nearby · just now"
   - Trust note: "Reported by nearby user — not verified"
3. (Optional) On **Phone B**, tap the "✕" (Dismiss) button. The alert will disappear from the UI.

### Test C: Deduplication and Merging (Anti-Spam)
1. Restart the app on **Phone A** (this clears the in-memory rate limiter).
2. On **Phone A**, send another **Medical** alert.
3. Look at **Phone B** (if you didn't dismiss it) or **Phone C** (a third device).
4. The alert feed should now say: **"2 people nearby"** instead of showing two separate medical alerts. This verifies the `window_bucket` SQLite constraint is merging reports for the same incident in the same 5-minute window.

### Test D: Safe Heartbeat
1. On **Phone B**, tap the wide green **I'm Safe (🟢)** button.
2. Hold the button for 1.5 seconds.
3. On **Phone A**, check the Contacts list. You should see a status indicating that the peer is "Safe" (heartbeat received).

### Test E: Panic Wipe
1. On **Phone B**, tap **SETTINGS** at the top right.
2. Find the panic wipe / delete everything button and trigger it.
3. Return to the Home screen on Phone B.
4. Verify that the Alert Feed is completely empty. The atomic database wipe destroys `emergency_alerts` and `heartbeats` alongside chat messages.

## 4. Expected Background Behaviors

- **15-Minute Expiry:** Leave an alert on the screen. After 15 minutes, the database `sweepExpired()` function runs. The alert will automatically vanish from the feed because 15-minute-old emergencies are no longer actionable.
- **Silent Discarding:** If an older version of the app (without this code) receives these messages, it will silently drop them (`return null` in `decodeBody`), ensuring no crashes on legacy clients.
- **No Chat Pollution:** Emergency messages will **never** appear inside the `#public` chat channel or direct messages. They are routed exclusively to the Alert Feed.

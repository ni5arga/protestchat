package expo.modules.blemesh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder

/**
 * Foreground service that keeps the mesh radio process alive while the app is
 * backgrounded.
 *
 * Android 8+ (API 26) throttles or stops background BLE work unless the app holds
 * a foreground service. This service does not itself talk to the radio — the
 * BleMeshModule does — it only creates a persistent notification so the OS
 * knows the process is doing user-visible work. The module starts it when
 * advertising or scanning begins and stops it in teardown().
 *
 * The notification is deliberately discreet: it does not appear on the lock
 * screen and it does not describe what the app is doing, because a visible
 * lock-screen tell would defeat the purpose of a privacy-first mesh app. The
 * OS still shows the app label in the notification shade (unavoidable), but
 * that is only visible to someone who already has the unlocked phone.
 */
class BleMeshService : Service() {

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Bluetooth background use",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Used while the app is backgrounded."
      }
      val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      notificationManager.createNotificationChannel(channel)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = buildNotification()
    startForeground(FOREGROUND_ID, notification)
    return START_STICKY
  }

  private fun buildNotification(): Notification {
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }

    builder
      .setContentTitle("Bluetooth active")
      .setContentText("Running in the background.")
      .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
      .setOngoing(true)
      .setWhen(System.currentTimeMillis())

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      builder.setCategory(Notification.CATEGORY_SERVICE)
    }

    // Never show this notification on the lock screen. A persistent, self-
    // describing lock-screen tell would be more damaging than the benefit of
    // background relaying.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      builder.setVisibility(Notification.VISIBILITY_SECRET)
    }

    // Tapping the notification returns the user to the app rather than doing nothing.
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    if (launchIntent != null) {
      val pendingIntent = PendingIntent.getActivity(
        this,
        0,
        launchIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      builder.setContentIntent(pendingIntent)
    }

    return builder.build()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  companion object {
    private const val CHANNEL_ID = "protestchat_mesh_relay"
    private const val FOREGROUND_ID = 1
  }
}

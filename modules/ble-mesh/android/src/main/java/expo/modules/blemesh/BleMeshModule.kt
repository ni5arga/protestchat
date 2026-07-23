package expo.modules.blemesh

// Android BLE GATT mesh transport for Expo.
//
// IMPORTANT: this file is a *dumb byte pipe*. It must never learn anything about
// chat: no message parsing, no dedup of application messages, no storage, no
// crypto. Bytes in, bytes out, plus peer/link lifecycle events.
//
// The one thing above raw GATT it is allowed to do is *framing* - splitting a
// payload across MTU-sized writes and reassembling it. That is transport
// plumbing, not chat logic, and it cannot live anywhere else: the MTU is only
// known here, per link, and only after negotiation.
//
// Every device is simultaneously a GATT server (advertising + serving) and a
// GATT client (scanning + connecting). There is no client/server role in a mesh.
// Two Android devices connect in both directions at once. Both wires are kept
// behind one logical peer so each phone can send through its GATT-client write
// path; some Android servers silently lose larger notification payloads.

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.os.bundleOf
import expo.modules.interfaces.permissions.PermissionsResponse
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.SecureRandom
import java.util.UUID

// ---------------------------------------------------------------------------
// Wire constants
//
// Duplicated verbatim in src/constants.ts and in the Swift module. Change all
// three or none - these are the interop contract between an Android phone and an
// iPhone standing next to each other.
// ---------------------------------------------------------------------------

private val SERVICE_UUID: UUID = UUID.fromString("7b3c1a80-9f42-4e17-9a6d-2c5e8b1f0d31")
private val INBOUND_UUID: UUID = UUID.fromString("7b3c1a81-9f42-4e17-9a6d-2c5e8b1f0d31")
private val OUTBOUND_UUID: UUID = UUID.fromString("7b3c1a82-9f42-4e17-9a6d-2c5e8b1f0d31")

/** Client Characteristic Configuration Descriptor. Android requires it explicitly. */
private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

private const val HEADER_LEN = 8
private const val FRAME_VERSION: Byte = 0x01
private const val TYPE_DATA: Byte = 0x00
private const val TYPE_HELLO: Byte = 0x01

private const val MAX_MESSAGE_BYTES = 32_768
private const val MAX_ASSEMBLIES_PER_PEER = 4
private const val ASSEMBLY_TIMEOUT_MS = 30_000L
private const val DEFAULT_ROTATION_MS = 15L * 60L * 1000L
private const val TAG_BYTES = 8
private const val ADVERTISED_TAG_BYTES = 4
private const val HELLO_TIMEOUT_MS = 10_000L
private const val PEER_STALE_MS = 30_000L
private const val HOUSEKEEPING_MS = 5_000L

/**
 * Floor until negotiation completes. ATT_MTU 23 minus the 3-byte opcode + handle.
 * Never assume more than this before the peer tells us otherwise.
 */
private const val MIN_USABLE_WRITE = 20

/**
 * GATT servers on older Android builds can report a 517-byte MTU yet silently
 * drop indications near that size. Keep the server-to-client path below the
 * widely supported 185-byte ATT MTU; client writes may still use the full
 * negotiated size.
 */
private const val MAX_SERVER_FRAME_BYTES = 180

/** What we ask for. Android caps at 517; 512 is the largest useful ATT payload. */
private const val REQUESTED_MTU = 512

private const val LOG_TAG = "BleMesh"

/**
 * How long a link may sit with an outstanding GATT operation before we assume the
 * completion callback is never coming. See [BleMeshModule.checkPumpWatchdog].
 */
private const val WRITE_WATCHDOG_MS = 4_000L

/**
 * How long we let `requestMtu` try before discovering services anyway. A larger
 * MTU is an optimisation; the 23-byte default is slow, not broken, and a stack
 * that never delivers `onMtuChanged` must not cost us the whole link.
 */
private const val MTU_GRACE_MS = 600L

/**
 * Cap on outbound (GATT client) links. Android hands out roughly seven before
 * every `connectGatt` starts failing with status 133, and the inbound direction
 * consumes from the same budget on some stacks, so we stay comfortably under it.
 * A mesh is fed by relaying, not by holding every peer at once.
 */
private const val MAX_OUTBOUND_LINKS = 4

/** Exponential backoff after a failed dial, per peer. */
private const val BACKOFF_BASE_MS = 2_000L
private const val BACKOFF_MAX_MS = 60_000L

/**
 * Give up re-issuing a chunk the stack keeps refusing. 20 x 25 ms is half a
 * second of "not now", which is far longer than real congestion lasts and is the
 * point at which the refusal is structural rather than transient.
 */
private const val MAX_ISSUE_RETRIES = 20

/**
 * Coded error identifiers. Duplicated verbatim in the iOS implementation.
 */
private object BleErrorCode {
  const val UNSUPPORTED = "ERR_BLE_UNSUPPORTED"
  const val POWERED_OFF = "ERR_BLE_POWERED_OFF"
  const val UNAUTHORIZED = "ERR_BLE_UNAUTHORIZED"
  const val LOCATION_OFF = "ERR_BLE_LOCATION_OFF"
  const val NOT_STARTED = "ERR_BLE_NOT_STARTED"
  const val UNKNOWN_PEER = "ERR_BLE_UNKNOWN_PEER"
  const val NOT_CONNECTED = "ERR_BLE_NOT_CONNECTED"
  const val INVALID_PAYLOAD = "ERR_BLE_INVALID_PAYLOAD"
  const val PAYLOAD_TOO_LARGE = "ERR_BLE_PAYLOAD_TOO_LARGE"
  const val ADVERTISE_FAILED = "ERR_BLE_ADVERTISE_FAILED"
  const val SCAN_FAILED = "ERR_BLE_SCAN_FAILED"
  const val CONNECT_FAILED = "ERR_BLE_CONNECT_FAILED"
  const val SEND_FAILED = "ERR_BLE_SEND_FAILED"
  const val NO_CONTEXT = "ERR_BLE_NO_CONTEXT"
  const val INTERNAL = "ERR_BLE_INTERNAL"
}

private class BleMeshException(code: String, message: String) : CodedException(code, message, null)

// ---------------------------------------------------------------------------
// Reassembly
// ---------------------------------------------------------------------------

private class Assembly(val count: Int) {
  val startedAt: Long = SystemClock.elapsedRealtime()
  val chunks = HashMap<Int, ByteArray>()
  var bytes = 0
}

/**
 * Per-link inbound reassembly.
 *
 * Everything here exists because the far side is an untrusted radio. A peer that
 * opens thousands of messages and never finishes them is the cheapest possible
 * denial of service against a phone, so the buffer is bounded three separate
 * ways: by concurrent messages, by bytes per message, and by age.
 */
private class Reassembler {
  private val assemblies = HashMap<Int, Assembly>()

  /**
   * Returns a complete payload, or null if this chunk did not complete one.
   * A partially reassembled payload is NEVER returned.
   */
  fun accept(messageId: Int, index: Int, count: Int, payload: ByteArray): ByteArray? {
    // A zero-chunk message is meaningless, and an index outside the declared
    // range is either a bug or an attempt to make us allocate a sparse array.
    if (count <= 0 || index < 0 || index >= count) return null

    // Single-chunk fast path: the overwhelming majority of control traffic, and
    // it never touches the assembly table, so a flood of small messages cannot
    // evict a large transfer in progress.
    if (count == 1) return if (payload.size <= MAX_MESSAGE_BYTES) payload else null

    sweep()

    val existing = assemblies[messageId]
    if (existing != null && existing.count != count) {
      // The peer changed its mind about how long this message is. Either a
      // messageId wrapped into a live assembly or the peer is hostile; drop the
      // whole thing rather than splice two different messages together.
      assemblies.remove(messageId)
      return null
    }

    val assembly = existing ?: run {
      if (assemblies.size >= MAX_ASSEMBLIES_PER_PEER) {
        // Evict the oldest, not the newest. A flooder should not be able to lock
        // out a legitimate transfer that is already most of the way done.
        assemblies.entries.minByOrNull { it.value.startedAt }?.let { assemblies.remove(it.key) }
      }
      Assembly(count).also { assemblies[messageId] = it }
    }

    // Duplicate chunk: ignore silently. Notifications can be re-delivered, and
    // both link directions can carry the same message during a duplicate-link
    // race that has not been resolved yet.
    if (assembly.chunks.containsKey(index)) return null

    if (assembly.bytes + payload.size > MAX_MESSAGE_BYTES) {
      assemblies.remove(messageId)
      return null
    }

    assembly.chunks[index] = payload
    assembly.bytes += payload.size

    if (assembly.chunks.size != assembly.count) return null

    // Out-of-order arrival is normal; ordering happens here, at completion.
    val out = ByteArray(assembly.bytes)
    var offset = 0
    for (i in 0 until assembly.count) {
      val piece = assembly.chunks[i] ?: run {
        assemblies.remove(messageId)
        return null
      }
      piece.copyInto(out, offset)
      offset += piece.size
    }
    assemblies.remove(messageId)
    return out
  }

  fun sweep() {
    val cutoff = SystemClock.elapsedRealtime() - ASSEMBLY_TIMEOUT_MS
    val iterator = assemblies.entries.iterator()
    while (iterator.hasNext()) {
      if (iterator.next().value.startedAt < cutoff) iterator.remove()
    }
  }

  fun clear() = assemblies.clear()
}

// ---------------------------------------------------------------------------
// Link
// ---------------------------------------------------------------------------

/** One GATT link, in whichever direction it happens to have formed. */
private class Link(
  val peerId: String,
  val isIncoming: Boolean,
  val device: BluetoothDevice,
) {
  /** Client role (we dialled out). Null for an inbound link. */
  var gatt: BluetoothGatt? = null
  var inbound: BluetoothGattCharacteristic? = null

  var usableWrite = MIN_USABLE_WRITE
  var confirmNotifications = false
  var remoteTag: String? = null
  var announced = false
  var helloSent = false
  val openedAt: Long = SystemClock.elapsedRealtime()

  var nextMessageId: Int = SecureRandom().nextInt(0x10000)
  val reassembler = Reassembler()

  /**
   * Chunks waiting for the radio. Android permits exactly one outstanding GATT
   * operation per connection and silently fails the rest, so every chunk goes
   * through this queue and the next one is only issued from the completion
   * callback of the previous.
   */
  val pending = ArrayDeque<ByteArray>()
  var busy = false

  /**
   * When [busy] was last set. The whole pump depends on `onCharacteristicWrite` /
   * `onNotificationSent` coming back, and on some stacks one of them simply does
   * not arrive - at which point the link latches mute forever with no error
   * anywhere. Housekeeping watches this timestamp so the worst case is a slow
   * link rather than a dead one.
   */
  var busySince: Long = 0

  /** How many consecutive times the stack has refused to accept the head frame. */
  var issueRetries = 0

  /**
   * Service discovery is kicked off by whichever of `onMtuChanged` and the MTU
   * grace timer gets there first, so it has to be idempotent.
   */
  var discoveryStarted = false
}

private class Discovered(
  val device: BluetoothDevice,
  var lastSeen: Long,
  var advertisedTag: String,
)

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

@SuppressLint("MissingPermission")
class BleMeshModule : Module() {
  /**
   * Every piece of mutable state below is touched only on this thread, including
   * from the BLE callbacks (which are given this handler) and from every
   * AsyncFunction. A single thread rather than a lock because the GATT callbacks
   * reenter and a recursive lock around this much state is how you get a deadlock
   * you can only reproduce in a crowd.
   */
  private val thread = HandlerThread("org.protestchat.blemesh").apply { start() }
  private val handler = Handler(thread.looper)

  /**
   * Events must reach the JS runtime from the main looper; BLE callbacks arrive
   * on [thread] and must not touch it directly.
   */
  private val mainHandler = Handler(Looper.getMainLooper())

  private var adapter: BluetoothAdapter? = null
  private var gattServer: BluetoothGattServer? = null
  private var outboundCharacteristic: BluetoothGattCharacteristic? = null

  private var wantAdvertising = false
  private var wantScanning = false
  private var advertising = false
  private var scanning = false
  private var sendErrorActive = false

  /** Current ephemeral identifier. See rotate(). */
  private var localTag = ByteArray(0)
  private var rotationMs = DEFAULT_ROTATION_MS

  private val links = HashMap<String, Link>()

  /** "c:$address" / "p:$address" -> peerId. Keyed by role so the two directions
   *  of a duplicate link get distinct handles and can be told apart. */
  private val peerIds = HashMap<String, String>()
  private val discovered = HashMap<String, Discovered>()

  /**
   * Consecutive failed dials per peer, and the moment we are next allowed to try
   * again. Both phones dial on every sighting, and a peer whose stack is wedged
   * (status 133 is the classic) will refuse every attempt - retrying it at scan
   * rate is how an Android BLE app burns its GATT client slots and its battery
   * at the same time.
   */
  private val connectFailures = HashMap<String, Int>()
  private val backoffUntil = HashMap<String, Long>()

  private var lastPublishedState: String? = null
  private var housekeepingScheduled = false
  private var stateReceiver: BroadcastReceiver? = null
  private var serviceStarted = false

  private val random = SecureRandom()

  // -------------------------------------------------------------------------
  // Definition
  // -------------------------------------------------------------------------

  override fun definition() = ModuleDefinition {
    Name("BleMesh")

    Events(
      "onPeerFound",
      "onPeerLost",
      "onConnected",
      "onDisconnected",
      "onPayload",
      "onStateChange",
      "onError"
    )

    OnDestroy {
      runCatching { handler.post { teardown() } }
      runCatching { unregisterStateReceiver() }
      runCatching { thread.quitSafely() }
    }

    AsyncFunction("startAdvertising") { rotationMillis: Double, promise: Promise ->
      withPermissions(promise) {
        handler.post {
          rotationMs = if (rotationMillis > 0) rotationMillis.toLong() else DEFAULT_ROTATION_MS
          wantAdvertising = true
          if (localTag.isEmpty()) localTag = randomBytes(TAG_BYTES)
          registerStateReceiver()
          if (!ensureAdapter(promise)) return@post
          if (!ensureGattServer(promise)) return@post
          scheduleRotation()
          scheduleHousekeeping()
          startAdvertisingNow()
          startForegroundServiceIfNeeded()
          promise.resolve(null)
        }
      }
    }

    AsyncFunction("startScanning") { promise: Promise ->
      withPermissions(promise) {
        handler.post {
          wantScanning = true
          if (localTag.isEmpty()) localTag = randomBytes(TAG_BYTES)
          registerStateReceiver()
          if (!ensureAdapter(promise)) return@post
          scheduleHousekeeping()
          startScanningNow()
          startForegroundServiceIfNeeded()
          promise.resolve(null)
        }
      }
    }

    AsyncFunction("stopAll") { promise: Promise ->
      handler.post {
        teardown()
        promise.resolve(null)
      }
    }

    AsyncFunction("connect") { peerId: String, promise: Promise ->
      handler.post {
        // Idempotent by contract: both devices will call this about each other at
        // the same moment, and a second call must not produce a second link or an
        // error the caller has to special-case. This is also what refuses to dial
        // a peer that is already connected *or still connecting* - the link is in
        // the table from the instant connectGatt is issued, not from onConnected.
        if (links.containsKey(peerId)) {
          promise.resolve(null)
          return@post
        }
        val entry = discovered[peerId]
        if (entry == null) {
          failPromise(
            promise,
            BleErrorCode.UNKNOWN_PEER,
            "Unknown peer '$peerId'. It was never discovered, or it was already lost."
          )
          return@post
        }
        val context = appContext.reactContext
        if (context == null) {
          failPromise(promise, BleErrorCode.NO_CONTEXT, "React context is unavailable.")
          return@post
        }

        val now = SystemClock.elapsedRealtime()
        val until = backoffUntil[peerId] ?: 0L
        if (now < until) {
          failPromise(
            promise,
            BleErrorCode.CONNECT_FAILED,
            "Backing off from '$peerId' for another ${(until - now) / 1000}s after " +
              "${connectFailures[peerId] ?: 0} failed connect attempt(s)."
          )
          return@post
        }

        // A slot refused now is a slot available for the next peer that appears.
        // Exceeding the stack's limit is not refused, it is *silently* failed with
        // status 133 - and then every later connect fails too.
        val outbound = links.values.count { !it.isIncoming }
        if (outbound >= MAX_OUTBOUND_LINKS) {
          failPromise(
            promise,
            BleErrorCode.CONNECT_FAILED,
            "Already holding $outbound outbound links, which is this transport's cap."
          )
          return@post
        }

        val link = Link(peerId, isIncoming = false, device = entry.device)
        links[peerId] = link
        val gatt = runCatching {
          entry.device.connectGatt(
            context,
            // autoConnect=false: the direct path. autoConnect=true queues the
            // connection in the stack's background scanner, which can sit unfired
            // for minutes - useless when both phones are only in range while their
            // owners walk past each other.
            false,
            gattClientCallback,
            BluetoothDevice.TRANSPORT_LE
          )
        }.getOrNull()

        if (gatt == null) {
          // No BluetoothGatt means no callbacks will ever arrive for this peer, so
          // nothing else would ever clean the placeholder link up.
          links.remove(peerId)
          noteConnectFailure(peerId)
          failPromise(
            promise,
            BleErrorCode.CONNECT_FAILED,
            "The Bluetooth stack refused to open a GATT client for '$peerId'."
          )
          return@post
        }

        link.gatt = gatt
        promise.resolve(null)
      }
    }

    AsyncFunction("disconnect") { peerId: String, promise: Promise ->
      handler.post {
        // Never fail on an absent peer - callers use this in cleanup paths.
        links.values
          .filter { it.peerId == peerId || it.remoteTag == peerId }
          .map { it.peerId }
          .forEach { dropLink(it, announce = true) }
        promise.resolve(null)
      }
    }

    AsyncFunction("send") { peerId: String, payloadBase64: String, promise: Promise ->
      val bytes = try {
        Base64.decode(payloadBase64, Base64.DEFAULT)
      } catch (error: IllegalArgumentException) {
        failPromise(promise, BleErrorCode.INVALID_PAYLOAD, "payloadBase64 is not valid base64.")
        return@AsyncFunction
      }

      handler.post {
        val candidates = links.values.filter {
          it.announced && (it.peerId == peerId || it.remoteTag == peerId)
        }
        // Android-to-Android peers normally have one link in each direction.
        // Writes from the GATT client are reliable across the Samsung stacks we
        // support; server notifications remain the fallback when that is the
        // only link a cross-platform peer kept.
        val link = candidates.firstOrNull { !it.isIncoming } ?: candidates.firstOrNull()
        if (link == null) {
          failPromise(promise, BleErrorCode.NOT_CONNECTED, "Peer '$peerId' is not connected.")
          return@post
        }
        if (bytes.size > MAX_MESSAGE_BYTES) {
          failPromise(
            promise,
            BleErrorCode.PAYLOAD_TOO_LARGE,
            "Payload of ${bytes.size} bytes exceeds the $MAX_MESSAGE_BYTES byte transport limit."
          )
          return@post
        }
        if (!enqueue(link, TYPE_DATA, bytes)) {
          failPromise(
            promise,
            BleErrorCode.SEND_FAILED,
            "Payload does not fit the framing header's chunk count."
          )
          return@post
        }
        pump(link)
        promise.resolve(null)
      }
    }

    AsyncFunction("getStatus") { promise: Promise ->
      handler.post { promise.resolve(statusBundle()) }
    }

    AsyncFunction("requestAccess") { promise: Promise ->
      requestAccess(promise)
    }

    AsyncFunction("isAvailable") { promise: Promise ->
      handler.post { promise.resolve(currentState() == "ready") }
    }

    AsyncFunction("rotateNow") { promise: Promise ->
      handler.post {
        rotate()
        promise.resolve(null)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Radio lifecycle
  // -------------------------------------------------------------------------

  private fun startForegroundServiceIfNeeded() {
    if (serviceStarted) return
    val context = appContext.reactContext ?: return
    val intent = Intent(context, BleMeshService::class.java)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        @Suppress("DEPRECATION")
        context.startService(intent)
      }
      serviceStarted = true
    } catch (e: Throwable) {
      // Foreground service is best-effort. If the OS refuses it, the radio still
      // works while the app is foregrounded; emit an advisory error so the UI can
      // tell the user background relay is not available.
      emitError(BleErrorCode.INTERNAL, "Could not start mesh foreground service: ${describe(e)}")
    }
  }

  private fun stopForegroundService() {
    if (!serviceStarted) return
    val context = appContext.reactContext ?: return
    val intent = Intent(context, BleMeshService::class.java)
    runCatching { context.stopService(intent) }
    serviceStarted = false
  }

  private fun ensureAdapter(promise: Promise?): Boolean {
    if (adapter == null) {
      val context = appContext.reactContext
      if (context == null) {
        promise?.let { failPromise(it, BleErrorCode.NO_CONTEXT, "React context is unavailable.") }
        return false
      }
      val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
      adapter = manager?.adapter
    }
    val current = adapter
    if (current == null) {
      promise?.let { failPromise(it, BleErrorCode.UNSUPPORTED, describe("unsupported")) }
      return false
    }
    if (!current.isEnabled) {
      promise?.let { failPromise(it, BleErrorCode.POWERED_OFF, describe("poweredOff")) }
      return false
    }
    return true
  }

  private fun ensureGattServer(promise: Promise?): Boolean {
    if (gattServer != null) return true
    val context = appContext.reactContext ?: return false
    val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    val server = manager?.openGattServer(context, gattServerCallback)
    if (server == null) {
      promise?.let {
        failPromise(it, BleErrorCode.UNSUPPORTED, "This device cannot act as a GATT server.")
      }
      return false
    }

    val inbound = BluetoothGattCharacteristic(
      INBOUND_UUID,
      BluetoothGattCharacteristic.PROPERTY_WRITE or
        BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
      BluetoothGattCharacteristic.PERMISSION_WRITE
    )
    val outbound = BluetoothGattCharacteristic(
      OUTBOUND_UUID,
      BluetoothGattCharacteristic.PROPERTY_NOTIFY or
        BluetoothGattCharacteristic.PROPERTY_INDICATE,
      BluetoothGattCharacteristic.PERMISSION_READ
    )
    // A NOTIFY characteristic without a CCCD is unsubscribable on Android and
    // invisible to a well-behaved central. iOS adds this for you; Android does not.
    outbound.addDescriptor(
      BluetoothGattDescriptor(
        CCCD_UUID,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
      )
    )

    val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    service.addCharacteristic(inbound)
    service.addCharacteristic(outbound)
    server.addService(service)

    gattServer = server
    outboundCharacteristic = outbound
    return true
  }

  private fun startAdvertisingNow() {
    if (!wantAdvertising || advertising) return
    val advertiser = adapter?.bluetoothLeAdvertiser
    if (advertiser == null) {
      emitError(BleErrorCode.UNSUPPORTED, "This device cannot advertise over Bluetooth LE.")
      return
    }

    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
      .setConnectable(true)
      .setTimeout(0)
      .build()

    // What actually goes on the air.
    //
    // Exactly two things: the service UUID, and four CSPRNG bytes.
    //
    // NOT the display name. NOT any part of the user's public key. NOT anything
    // derived from either. setIncludeDeviceName(false) is load-bearing: the
    // Android device name is something like "Nisarga's Pixel", it is stable for
    // the life of the phone, and broadcasting it would be a permanent tracking
    // beacon carrying a real human name. Peer identity is established by the
    // sealed payloads at the mesh layer; this transport only ever deals in
    // ephemeral, per-session handles.
    //
    // The tag goes in the scan response rather than the advertisement because a
    // 128-bit service UUID already spends 18 of the advertisement's 31 bytes.
    // That split is also what keeps Android's byte budget comfortable where
    // iOS's is not: the scan response is a second 31-byte packet all to itself,
    // so four bytes of service data here can never crowd out the service UUID a
    // scanner filters on. iOS has no such second packet - see the byte-budget
    // note in advertisementData() over there.
    val advertiseData = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .addServiceUuid(ParcelUuid(SERVICE_UUID))
      .build()

    val scanResponse = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .addServiceData(ParcelUuid(SERVICE_UUID), localTag.copyOf(ADVERTISED_TAG_BYTES))
      .build()

    runCatching {
      advertiser.startAdvertising(settings, advertiseData, scanResponse, advertiseCallback)
      advertising = true
    }.onFailure {
      emitError(BleErrorCode.ADVERTISE_FAILED, "Failed to start advertising: ${describe(it)}")
    }
  }

  private fun stopAdvertisingNow() {
    if (!advertising) return
    advertising = false
    runCatching { adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback) }
  }

  private fun startScanningNow() {
    if (!wantScanning || scanning) return
    val scanner = adapter?.bluetoothLeScanner
    if (scanner == null) {
      emitError(BleErrorCode.SCAN_FAILED, "Bluetooth LE scanning is unavailable.")
      return
    }

    val filters = listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build())
    val settings = ScanSettings.Builder()
      .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
      .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
      // Aggressive matching: at a protest peers appear and vanish as people move,
      // and a conservative matcher trades exactly the latency we cannot afford
      // for battery we would rather spend.
      .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
      .setNumOfMatches(ScanSettings.MATCH_NUM_MAX_ADVERTISEMENT)
      .build()

    runCatching {
      scanner.startScan(filters, settings, scanCallback)
      scanning = true
    }.onFailure {
      emitError(BleErrorCode.SCAN_FAILED, "Failed to start scanning: ${describe(it)}")
    }
  }

  private fun stopScanningNow() {
    if (!scanning) return
    scanning = false
    runCatching { adapter?.bluetoothLeScanner?.stopScan(scanCallback) }
  }

  // -------------------------------------------------------------------------
  // Rotation
  // -------------------------------------------------------------------------

  private val rotationRunnable = Runnable {
    rotate()
    scheduleRotation()
  }

  private fun scheduleRotation() {
    handler.removeCallbacks(rotationRunnable)
    handler.postDelayed(rotationRunnable, rotationMs)
  }

  /**
   * Replaces the ephemeral identifier with fresh CSPRNG bytes.
   *
   * The new tag is NOT derivable from the old one - no counter, no hash chain, no
   * key. That is the whole point: an observer who logged the previous tag must
   * not be able to recognise the same device afterwards. Anything derivable,
   * however cheap, would reduce this to a stable identifier with extra steps.
   *
   * Advertising is fully stopped and restarted rather than updated in place. The
   * app cannot set the BLE link-layer address - that belongs to the OS - but
   * tearing the advertising set down and building a new one is the only lever an
   * app has to give the stack an opportunity to re-randomise it. Our rotation is
   * necessary but not sufficient; see the README.
   *
   * Live links are deliberately NOT dropped. Cutting every link every fifteen
   * minutes would gut the mesh, and a link already established is already
   * correlated with us for its lifetime - rotating under it would buy nothing.
   */
  private fun rotate() {
    localTag = randomBytes(TAG_BYTES)
    if (wantAdvertising) {
      stopAdvertisingNow()
      startAdvertisingNow()
    }
  }

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  private val housekeepingRunnable = Runnable {
    housekeeping()
    housekeepingScheduled = false
    scheduleHousekeeping()
  }

  private fun scheduleHousekeeping() {
    if (housekeepingScheduled) return
    if (!wantAdvertising && !wantScanning) return
    housekeepingScheduled = true
    handler.postDelayed(housekeepingRunnable, HOUSEKEEPING_MS)
  }

  /** Ages out stale discoveries, un-HELLO'd links and abandoned reassemblies. */
  private fun housekeeping() {
    val now = SystemClock.elapsedRealtime()

    val staleIterator = discovered.entries.iterator()
    while (staleIterator.hasNext()) {
      val (peerId, entry) = staleIterator.next()
      if (now - entry.lastSeen > PEER_STALE_MS) {
        staleIterator.remove()
        if (!links.containsKey(peerId)) emit("onPeerLost", bundleOf("id" to peerId))
      }
    }

    for (peerId in links.keys.toList()) {
      val link = links[peerId] ?: continue
      if (!link.announced && now - link.openedAt > HELLO_TIMEOUT_MS) {
        // No HELLO means no transport identity, which means we can neither
        // deduplicate nor address it. Holding it open only burns one of the
        // handful of concurrent GATT links the stack will give us - Android
        // typically caps around seven, after which every connect silently fails.
        dropLink(peerId, announce = false)
      } else {
        link.reassembler.sweep()
        checkPumpWatchdog(link, now)
      }
    }
  }

  /**
   * Un-sticks a link whose GATT completion callback never arrived.
   *
   * The pump is entirely callback-driven: `busy` is set when a frame is handed to
   * the stack and cleared only by `onCharacteristicWrite` / `onNotificationSent`.
   * A stack that drops one of those leaves the link permanently mute and, worse,
   * completely silent about it - the queue just stops draining. Clearing `busy`
   * and re-pumping costs at most one duplicate frame, which the far side's
   * reassembler already ignores by index.
   *
   * UNVERIFIABLE WITHOUT HARDWARE: whether any shipping stack actually drops
   * these callbacks cannot be established from here. This makes it survivable
   * either way - a slow link instead of a dead one - and makes it loud.
   */
  private fun checkPumpWatchdog(link: Link, now: Long) {
    if (!link.busy || now - link.busySince <= WRITE_WATCHDOG_MS) return
    emitSendError(
      "Link '${link.peerId}' saw no GATT completion callback for " +
        "${WRITE_WATCHDOG_MS / 1000}s; continuing with ${link.pending.size} queued chunk(s)."
    )
    link.busy = false
    link.issueRetries = 0
    pump(link)
  }

  /** Exponential, capped, and reset the moment a link actually works. */
  private fun noteConnectFailure(peerId: String) {
    val failures = (connectFailures[peerId] ?: 0) + 1
    connectFailures[peerId] = failures
    val delay = minOf(BACKOFF_MAX_MS, BACKOFF_BASE_MS shl minOf(failures - 1, 16))
    backoffUntil[peerId] = SystemClock.elapsedRealtime() + delay
  }

  private fun clearConnectFailures(peerId: String) {
    connectFailures.remove(peerId)
    backoffUntil.remove(peerId)
  }

  // -------------------------------------------------------------------------
  // Framing
  // -------------------------------------------------------------------------

  /**
   * Splits [payload] into chunks and queues them. Returns false if the payload
   * cannot be expressed in the header's 16-bit chunk count.
   */
  private fun enqueue(link: Link, type: Byte, payload: ByteArray): Boolean {
    val maxChunk = maxOf(1, link.usableWrite - HEADER_LEN)
    val count = if (payload.isEmpty()) 1 else (payload.size + maxChunk - 1) / maxChunk
    if (count > 0xffff) return false

    val messageId = link.nextMessageId
    link.nextMessageId = (messageId + 1) and 0xffff

    for (index in 0 until count) {
      val start = index * maxChunk
      val end = minOf(start + maxChunk, payload.size)
      val frame = ByteArray(HEADER_LEN + maxOf(0, end - start))
      frame[0] = FRAME_VERSION
      frame[1] = type
      frame[2] = ((messageId shr 8) and 0xff).toByte()
      frame[3] = (messageId and 0xff).toByte()
      frame[4] = ((index shr 8) and 0xff).toByte()
      frame[5] = (index and 0xff).toByte()
      frame[6] = ((count shr 8) and 0xff).toByte()
      frame[7] = (count and 0xff).toByte()
      if (start < end) payload.copyInto(frame, HEADER_LEN, start, end)
      link.pending.addLast(frame)
    }
    return true
  }

  /**
   * Issues the next chunk, if the link is idle.
   *
   * Android permits exactly one outstanding GATT operation per connection and
   * fails - not queues - the rest. Firing a whole 30 KB envelope in a loop
   * therefore delivers the first chunk and silently discards the other fifty-nine,
   * which surfaces two layers up as a message that simply never arrives.
   */
  private fun pump(link: Link) {
    if (link.busy) return
    val frame = link.pending.firstOrNull() ?: return

    val issued = if (link.isIncoming) notifyFrame(link, frame) else writeFrame(link, frame)
    if (issued) {
      link.pending.removeFirst()
      link.busy = true
      link.busySince = SystemClock.elapsedRealtime()
      link.issueRetries = 0
    } else if (link.issueRetries >= MAX_ISSUE_RETRIES) {
      // Half a second of uninterrupted refusal is not congestion, it is a link
      // that cannot carry anything. Spinning on it forever would keep a GATT slot
      // and a wakelock alive for a peer that will never hear us, so drop the
      // queue loudly and let the epidemic mesh deliver by another route.
      link.issueRetries = 0
      val dropped = link.pending.size
      link.pending.clear()
      emitSendError(
        "The stack refused $dropped chunk(s) for '${link.peerId}' for " +
          "${MAX_ISSUE_RETRIES * 25}ms; giving up on them."
      )
    } else {
      // Transient stack congestion. Retry rather than drop; the completion
      // callbacks are what normally drive this loop.
      link.issueRetries += 1
      handler.postDelayed({ if (links[link.peerId] === link) pump(link) }, 25)
    }
  }

  private fun writeFrame(link: Link, frame: ByteArray): Boolean {
    val gatt = link.gatt ?: return false
    val characteristic = link.inbound ?: return false
    val writeType = if (
      characteristic.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0
    ) {
      BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
    } else {
      BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
    }

    return runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        gatt.writeCharacteristic(characteristic, frame, writeType) == BluetoothGatt.GATT_SUCCESS
      } else {
        @Suppress("DEPRECATION")
        run {
          characteristic.writeType = writeType
          characteristic.value = frame
          gatt.writeCharacteristic(characteristic)
        }
      }
    }.getOrDefault(false)
  }

  private fun notifyFrame(link: Link, frame: ByteArray): Boolean {
    val server = gattServer ?: return false
    val characteristic = outboundCharacteristic ?: return false
    return runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        server.notifyCharacteristicChanged(
          link.device,
          characteristic,
          link.confirmNotifications,
          frame
        ) ==
          BluetoothGatt.GATT_SUCCESS
      } else {
        @Suppress("DEPRECATION")
        run {
          characteristic.value = frame
          server.notifyCharacteristicChanged(
            link.device,
            characteristic,
            link.confirmNotifications
          )
        }
      }
    }.getOrDefault(false)
  }

  /** Feeds one received frame into a link. Called from either role. */
  private fun receive(link: Link, frame: ByteArray) {
    if (frame.size < HEADER_LEN) return
    if (frame[0] != FRAME_VERSION) return

    val type = frame[1]
    val messageId = ((frame[2].toInt() and 0xff) shl 8) or (frame[3].toInt() and 0xff)
    val index = ((frame[4].toInt() and 0xff) shl 8) or (frame[5].toInt() and 0xff)
    val count = ((frame[6].toInt() and 0xff) shl 8) or (frame[7].toInt() and 0xff)
    val payload = frame.copyOfRange(HEADER_LEN, frame.size)

    // Incomplete, duplicate, out of bounds or over budget: nothing goes up.
    val complete = link.reassembler.accept(messageId, index, count, payload) ?: return

    when (type) {
      TYPE_HELLO -> handleHello(link, complete)
      TYPE_DATA -> {
        // Data before HELLO is not addressable to anything. Drop rather than emit
        // a payload attributed to a peer handle nobody has been told about.
        if (!link.announced) return
        emit(
          "onPayload",
          bundleOf(
            "peerId" to (link.remoteTag ?: link.peerId),
            "payloadBase64" to Base64.encodeToString(complete, Base64.NO_WRAP)
          )
        )
      }
      // Unknown frame type from a future version. Ignore, do not disconnect - an
      // old build must stay usable in a mesh containing newer ones.
      else -> Unit
    }
  }

  private fun sendHello(link: Link) {
    if (link.helloSent) return
    link.helloSent = true
    enqueue(link, TYPE_HELLO, localTag)
    pump(link)
  }

  /**
   * A link becomes addressable only once the peer has told us its ephemeral tag.
   *
   * This is the *only* identity that matters. The advertised tag is a hint that
   * may be truncated, absent, or unreadable on one platform or the other; HELLO
   * is in-band, full width, and symmetric, so a link that connected with no
   * advertised tag at all still resolves normally here.
   */
  private fun handleHello(link: Link, tag: ByteArray) {
    if (tag.size != TAG_BYTES) {
      dropLink(link.peerId, announce = false)
      return
    }
    link.remoteTag = hex(tag)

    if (link.announced) return
    link.announced = true
    // A link that reached HELLO is proof the peer is dialable, so the backoff
    // ladder for it starts from scratch next time.
    clearConnectFailures(link.peerId)
    emit(
      "onConnected",
      bundleOf(
        // Both physical directions use the same logical id. JS stores connected
        // peers in a Set, so the second event triggers another inventory offer
        // without inflating "Connected to 1 phone" into two.
        "id" to link.remoteTag,
        "name" to "",
        "mtu" to link.usableWrite,
        "isIncoming" to link.isIncoming
      )
    )
  }

  // -------------------------------------------------------------------------
  // Link teardown
  // -------------------------------------------------------------------------

  private fun dropLink(peerId: String, announce: Boolean) {
    val link = links.remove(peerId) ?: return
    val logicalPeerId = link.remoteTag
    link.pending.clear()
    link.reassembler.clear()
    link.gatt?.let { gatt ->
      runCatching { gatt.disconnect() }
      // close() is not optional: an unclosed BluetoothGatt leaks its binder and,
      // after a handful of them, every subsequent connectGatt on the device fails
      // with status 133 until the app is restarted.
      runCatching { gatt.close() }
    }
    if (link.isIncoming) {
      runCatching { gattServer?.cancelConnection(link.device) }
    }
    if (
      announce &&
      link.announced &&
      logicalPeerId != null &&
      links.values.none { it.announced && it.remoteTag == logicalPeerId }
    ) {
      emit("onDisconnected", bundleOf("id" to logicalPeerId))
    }
  }

  private fun teardown() {
    handler.removeCallbacks(rotationRunnable)
    handler.removeCallbacks(housekeepingRunnable)
    housekeepingScheduled = false
    wantAdvertising = false
    wantScanning = false
    sendErrorActive = false

    stopAdvertisingNow()
    stopScanningNow()
    stopForegroundService()

    val announced = links.values.mapNotNull { if (it.announced) it.remoteTag else null }.distinct()
    for (link in links.values) {
      link.pending.clear()
      link.reassembler.clear()
      link.gatt?.let {
        runCatching { it.disconnect() }
        runCatching { it.close() }
      }
      if (link.isIncoming) runCatching { gattServer?.cancelConnection(link.device) }
    }
    links.clear()
    discovered.clear()
    peerIds.clear()
    connectFailures.clear()
    backoffUntil.clear()

    runCatching { gattServer?.close() }
    gattServer = null
    outboundCharacteristic = null

    // Leaving the tag behind after a stop would leave the last advertised
    // identifier recoverable from memory for no benefit.
    localTag = ByteArray(0)

    // A forced teardown does not deliver per-device disconnect callbacks, so
    // synthesise the terminal event. Callers must tolerate a disconnect for a
    // peer they already forgot.
    for (peerId in announced) emit("onDisconnected", bundleOf("id" to peerId))
  }

  // -------------------------------------------------------------------------
  // BLE callbacks
  // -------------------------------------------------------------------------

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartFailure(errorCode: Int) {
      handler.post {
        advertising = false
        emitError(
          BleErrorCode.ADVERTISE_FAILED,
          "Advertising failed to start (code $errorCode)."
        )
      }
    }
  }

  private val scanCallback = object : ScanCallback() {
    override fun onScanFailed(errorCode: Int) {
      handler.post {
        scanning = false
        emitError(BleErrorCode.SCAN_FAILED, "Scanning failed to start (code $errorCode).")
      }
    }

    override fun onScanResult(callbackType: Int, result: ScanResult) {
      handler.post { onAdvertisementSeen(result) }
    }

    override fun onBatchScanResults(results: MutableList<ScanResult>) {
      handler.post { results.forEach { onAdvertisementSeen(it) } }
    }
  }

  private fun onAdvertisementSeen(result: ScanResult) {
    val device = result.device ?: return
    val peerId = peerIdFor("c", device.address)

    // iOS peers publish the tag as the advertisement local name, because that is
    // the only field CoreBluetooth exposes to an app; Android peers publish it as
    // scan-response service data. Read whichever is present. Neither is trusted
    // for anything beyond noticing a rotation - the in-band HELLO is authoritative.
    //
    // UNVERIFIED ON HARDWARE: the two read paths are asymmetric (we read iOS's
    // local name, iOS reads our service data) and neither has been confirmed on
    // two physical phones. Everything below is written so that neither working is
    // survivable: an empty tag is not an error, does not suppress the discovery,
    // and does not stop connect(). The single consequence of a missing or
    // truncated tag is that we cannot notice this peer rotated - never that we
    // cannot reach it. The scan filter matches on the service UUID, which is in
    // the advertisement proper and cannot be crowded out by the tag.
    val record = result.scanRecord
    val serviceData = record?.getServiceData(ParcelUuid(SERVICE_UUID))
    val tag = when {
      serviceData != null && serviceData.isNotEmpty() -> hex(serviceData)
      // Taken verbatim, however short: a name the OS truncated is still stable
      // until the peer rotates, so it remains usable as a hint. It is never
      // parsed, never compared across peers, and never treated as identity.
      !record?.deviceName.isNullOrEmpty() -> record!!.deviceName!!
      else -> ""
    }

    val known = discovered[peerId]
    if (known == null) {
      discovered[peerId] = Discovered(device, SystemClock.elapsedRealtime(), tag)
      emit("onPeerFound", bundleOf("id" to peerId, "name" to ""))
      return
    }

    known.lastSeen = SystemClock.elapsedRealtime()
    // Report only the first sighting and any sighting after the peer rotated. The
    // scanner hands us the same advertisement several times a second, and
    // forwarding all of it would turn onPeerFound into a firehose the JS layer
    // has to debounce itself.
    if (tag.isNotEmpty() && tag != known.advertisedTag) {
      known.advertisedTag = tag
      emit("onPeerFound", bundleOf("id" to peerId, "name" to ""))
    }
  }

  /**
   * Starts service discovery exactly once per link. Two callers race for it -
   * `onMtuChanged` and the MTU grace timer - and discovering twice on the same
   * connection produces a second `onServicesDiscovered`, a second CCCD write and
   * a second HELLO on some stacks.
   */
  private fun startDiscovery(link: Link, gatt: BluetoothGatt) {
    if (link.discoveryStarted) return
    link.discoveryStarted = true
    if (!runCatching { gatt.discoverServices() }.getOrDefault(false)) {
      emitError(
        BleErrorCode.CONNECT_FAILED,
        "Service discovery could not be started for '${link.peerId}'."
      )
      dropLink(link.peerId, announce = true)
    }
  }

  private val gattClientCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      handler.post {
        val peerId = peerIdFor("c", gatt.device.address)
        val link = links[peerId]
        if (newState == BluetoothProfile.STATE_CONNECTED &&
          status == BluetoothGatt.GATT_SUCCESS
        ) {
          if (link == null) {
            // The link was already dropped (HELLO timeout, teardown, duplicate
            // resolution) while the connect was in flight. Nothing will ever
            // clean this BluetoothGatt up but us, and an unclosed one leaks the
            // binder that eventually turns every connectGatt into a 133.
            runCatching { gatt.disconnect() }
            runCatching { gatt.close() }
            return@post
          }

          // Ask for the bigger MTU first: requesting it *after* discovery works,
          // but the characteristics cache the old value on some stacks and we
          // would frame every chunk at 20 bytes forever.
          //
          // Do NOT gate discovery on onMtuChanged, though. A stack that never
          // delivers that callback would otherwise leave the link connected,
          // undiscovered and permanently useless. A large MTU is an optimisation;
          // the 23-byte default is slow, not broken.
          val requested = runCatching { gatt.requestMtu(REQUESTED_MTU) }.getOrDefault(false)
          if (requested) {
            handler.postDelayed({
              links[peerId]?.let { if (it === link) startDiscovery(link, gatt) }
            }, MTU_GRACE_MS)
          } else {
            startDiscovery(link, gatt)
          }
        } else {
          // Every terminal path closes. dropLink() does it for a link we still
          // hold; a gatt with no link behind it has to be closed here or its slot
          // is leaked for the life of the process.
          if (link != null) {
            if (!link.announced) noteConnectFailure(peerId)
            dropLink(peerId, announce = true)
          } else {
            runCatching { gatt.close() }
            noteConnectFailure(peerId)
          }
        }
      }
    }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      handler.post {
        val peerId = peerIdFor("c", gatt.device.address)
        val link = links[peerId] ?: return@post
        if (status == BluetoothGatt.GATT_SUCCESS) {
          // Three bytes of ATT overhead on every write. Floor at the
          // pre-negotiation minimum: a stack that reports a nonsense MTU must not
          // make us frame chunks that the radio then refuses.
          link.usableWrite = maxOf(MIN_USABLE_WRITE, mtu - 3)
        }
        // Whichever of this and the grace timer arrives first wins; the other is
        // a no-op.
        startDiscovery(link, gatt)
      }
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      handler.post {
        val peerId = peerIdFor("c", gatt.device.address)
        val link = links[peerId] ?: return@post
        val service = gatt.getService(SERVICE_UUID)
        val inbound = service?.getCharacteristic(INBOUND_UUID)
        val outbound = service?.getCharacteristic(OUTBOUND_UUID)
        if (inbound == null || outbound == null) {
          dropLink(peerId, announce = true)
          return@post
        }
        link.inbound = inbound

        gatt.setCharacteristicNotification(outbound, true)
        val cccd = outbound.getDescriptor(CCCD_UUID)
        if (cccd == null) {
          // No CCCD means we can write to this peer but never hear back. A
          // one-way link is worse than none in an epidemic mesh: we would relay
          // into it forever and never learn what it carries.
          dropLink(peerId, announce = true)
          return@post
        }
        val subscriptionValue = if (
          outbound.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0
        ) {
          BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
        } else {
          BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        }
        runCatching {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeDescriptor(cccd, subscriptionValue)
          } else {
            @Suppress("DEPRECATION")
            run {
              cccd.value = subscriptionValue
              gatt.writeDescriptor(cccd)
            }
          }
        }
      }
    }

    override fun onDescriptorWrite(
      gatt: BluetoothGatt,
      descriptor: BluetoothGattDescriptor,
      status: Int
    ) {
      handler.post {
        val link = links[peerIdFor("c", gatt.device.address)] ?: return@post
        // Only now can the peer reach us. HELLO is deliberately the first frame
        // on the wire in both directions.
        sendHello(link)
      }
    }

    override fun onCharacteristicWrite(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int
    ) {
      handler.post {
        val link = links[peerIdFor("c", gatt.device.address)] ?: return@post
        link.busy = false
        if (status != BluetoothGatt.GATT_SUCCESS) {
          emitSendError("Write to '${link.peerId}' failed with status $status.")
        } else {
          noteSendSuccess()
        }
        pump(link)
      }
    }

    @Suppress("DEPRECATION")
    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic
    ) {
      val value = characteristic.value ?: return
      handler.post {
        val link = links[peerIdFor("c", gatt.device.address)] ?: return@post
        if (characteristic.uuid == OUTBOUND_UUID) receive(link, value)
      }
    }

    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray
    ) {
      handler.post {
        val link = links[peerIdFor("c", gatt.device.address)] ?: return@post
        if (characteristic.uuid == OUTBOUND_UUID) receive(link, value)
      }
    }
  }

  private val gattServerCallback = object : BluetoothGattServerCallback() {
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      handler.post {
        val peerId = peerIdFor("p", device.address)
        if (newState == BluetoothProfile.STATE_CONNECTED) {
          if (!links.containsKey(peerId)) {
            links[peerId] = Link(peerId, isIncoming = true, device = device)
          }
        } else {
          dropLink(peerId, announce = true)
        }
      }
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      handler.post {
        links[peerIdFor("p", device.address)]?.usableWrite =
          minOf(maxOf(MIN_USABLE_WRITE, mtu - 3), MAX_SERVER_FRAME_BYTES)
      }
    }

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?
    ) {
      handler.post {
        if (responseNeeded) {
          runCatching {
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
          }
        }
        if (descriptor.uuid != CCCD_UUID) return@post
        val indicating = value != null &&
          value.contentEquals(BluetoothGattDescriptor.ENABLE_INDICATION_VALUE)
        val subscribing = indicating || (value != null &&
          value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE))
        val peerId = peerIdFor("p", device.address)
        if (subscribing) {
          val link = links.getOrPut(peerId) { Link(peerId, isIncoming = true, device = device) }
          // Indications are acknowledged by the client. Prefer them for Android
          // peers, whose notification stacks can report success while dropping
          // a multi-frame payload. Still honour plain notifications for iOS and
          // older peers that subscribe to that mode.
          link.confirmNotifications = indicating
          sendHello(link)
        } else {
          dropLink(peerId, announce = true)
        }
      }
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?
    ) {
      handler.post {
        if (responseNeeded) {
          runCatching {
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
          }
        }
        if (characteristic.uuid != INBOUND_UUID || value == null) return@post
        // Long writes are not part of the contract: our own framing already keeps
        // every write inside one MTU, so a non-zero offset can only come from a
        // peer doing something we did not ask for.
        if (offset != 0) return@post

        val peerId = peerIdFor("p", device.address)
        val link = links.getOrPut(peerId) { Link(peerId, isIncoming = true, device = device) }
        receive(link, value)
      }
    }

    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
      handler.post {
        val link = links[peerIdFor("p", device.address)] ?: return@post
        link.busy = false
        if (status != BluetoothGatt.GATT_SUCCESS) {
          emitSendError("Notification to '${link.peerId}' failed with status $status.")
        } else {
          noteSendSuccess()
        }
        pump(link)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Adapter state
  // -------------------------------------------------------------------------

  private fun registerStateReceiver() {
    if (stateReceiver != null) return
    val context = appContext.reactContext ?: return
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context?, intent: Intent?) {
        handler.post {
          publishStateIfChanged()
          if (currentState() == "ready") {
            // The user turned Bluetooth back on. Everything we wanted before is
            // still what we want; bring it back up without making JS re-drive it.
            ensureAdapter(null)
            ensureGattServer(null)
            startAdvertisingNow()
            startScanningNow()
          } else {
            advertising = false
            scanning = false
          }
        }
      }
    }
    runCatching {
      val filter = IntentFilter().apply {
        addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          addAction(LocationManager.MODE_CHANGED_ACTION)
        }
      }
      ContextCompat.registerReceiver(
        context,
        receiver,
        filter,
        ContextCompat.RECEIVER_NOT_EXPORTED
      )
      stateReceiver = receiver
    }
  }

  private fun unregisterStateReceiver() {
    val receiver = stateReceiver ?: return
    stateReceiver = null
    runCatching { appContext.reactContext?.unregisterReceiver(receiver) }
  }

  private fun currentState(): String {
    val context = appContext.reactContext ?: return "unknown"
    val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    val current = manager?.adapter ?: return "unsupported"
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
      return "unsupported"
    }
    // Permission is checked before power deliberately: a denied permission makes
    // isEnabled unreadable on some OEM builds and would otherwise be reported as
    // "Bluetooth is off", sending the user to fix something that is not broken.
    if (!hasRequiredPermissions(context)) return "unauthorized"
    if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R && !isLocationEnabled(context)) {
      return "locationOff"
    }
    if (!current.isEnabled) return "poweredOff"
    if (current.bluetoothLeAdvertiser == null) return "unsupported"
    return "ready"
  }

  private fun statusBundle(): Bundle {
    val state = currentState()
    return bundleOf(
      "state" to state,
      "available" to (state == "ready"),
      "message" to describe(state)
    )
  }

  private fun describe(state: String): String = when (state) {
    "ready" -> ""
    "poweredOff" -> "Bluetooth is switched off. Turn it on in Quick Settings."
    "unauthorized" -> "protestchat is not allowed to use Bluetooth. Grant the Nearby devices permission in Settings."
    "locationOff" -> "Location Services must be on for Bluetooth scanning on this version of Android."
    "unsupported" -> "This device cannot advertise over Bluetooth LE, so it cannot join the mesh."
    "resetting" -> "The Bluetooth stack is restarting."
    else -> "Bluetooth state is not known yet."
  }

  private fun publishStateIfChanged() {
    val state = currentState()
    if (state == lastPublishedState) return
    lastPublishedState = state
    emit("onStateChange", statusBundle())
    if (state != "ready" && state != "unknown") {
      val code = when (state) {
        "poweredOff" -> BleErrorCode.POWERED_OFF
        "unauthorized" -> BleErrorCode.UNAUTHORIZED
        "locationOff" -> BleErrorCode.LOCATION_OFF
        "unsupported" -> BleErrorCode.UNSUPPORTED
        else -> BleErrorCode.INTERNAL
      }
      emitError(code, describe(state))
    }
  }

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  /**
   * The permission set differs sharply either side of Android 12:
   *  - <= 30: legacy BLUETOOTH / BLUETOOTH_ADMIN are install-time, but a BLE scan
   *    returns nothing without ACCESS_FINE_LOCATION *and* Location Services on.
   *  - >= 31: the BLUETOOTH_SCAN / ADVERTISE / CONNECT runtime split, and because
   *    BLUETOOTH_SCAN is declared neverForLocation in our manifest, no location
   *    permission at all.
   */
  private fun requiredPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      arrayOf(
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_ADVERTISE,
        Manifest.permission.BLUETOOTH_CONNECT
      )
    } else {
      arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

  private fun hasRequiredPermissions(context: Context): Boolean =
    requiredPermissions().all {
      ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }

  private fun isLocationEnabled(context: Context): Boolean {
    val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
      ?: return false
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      manager.isLocationEnabled
    } else {
      manager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
        manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    }
  }

  /**
   * Requests the runtime permission first, then presents the OS-owned control
   * for the next unmet requirement. Android does not allow an app to silently
   * switch either Bluetooth or Location Services on; the user must approve the
   * system UI.
   */
  private fun requestAccess(promise: Promise) {
    val permissions = requiredPermissions()
    val manager = appContext.permissions
    if (manager == null) {
      mainHandler.post {
        promptForMissingRequirement()
        promise.resolve(statusBundle())
      }
      return
    }

    manager.askForPermissions(
      PermissionsResponseListener { result: Map<String, PermissionsResponse> ->
        val denied = permissions.any { result[it]?.status != PermissionsStatus.GRANTED }
        if (denied) {
          handler.post {
            publishStateIfChanged()
            promise.resolve(statusBundle())
          }
          return@PermissionsResponseListener
        }

        registerStateReceiver()
        mainHandler.post {
          promptForMissingRequirement()
          promise.resolve(statusBundle())
        }
      },
      *permissions
    )
  }

  private fun promptForMissingRequirement() {
    val activity = appContext.currentActivity ?: return
    val action = when (currentState()) {
      "locationOff" -> Settings.ACTION_LOCATION_SOURCE_SETTINGS
      "poweredOff" -> BluetoothAdapter.ACTION_REQUEST_ENABLE
      else -> return
    }
    runCatching { activity.startActivity(Intent(action)) }
      .onFailure { emitError(BleErrorCode.INTERNAL, describe(it)) }
  }

  /** Requests the API-level-appropriate permissions, then runs [block] if granted. */
  private fun withPermissions(promise: Promise, block: () -> Unit) {
    val permissions = requiredPermissions()
    val manager = appContext.permissions
    if (manager == null) {
      // No permissions service linked. Fall through and let the BLE stack itself
      // fail with a real error rather than blocking on a service we do not have.
      block()
      return
    }

    val listener = PermissionsResponseListener { result: Map<String, PermissionsResponse> ->
      val denied = permissions.filter { result[it]?.status != PermissionsStatus.GRANTED }
      if (denied.isEmpty()) {
        block()
      } else {
        failPromise(
          promise,
          BleErrorCode.UNAUTHORIZED,
          "Missing permissions required for Bluetooth LE: ${denied.joinToString(", ")}"
        )
      }
    }
    manager.askForPermissions(listener, *permissions)
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private fun peerIdFor(role: String, address: String): String =
    peerIds.getOrPut("$role:$address") { UUID.randomUUID().toString() }

  /**
   * SecureRandom, not Random: the tag is the only thing standing between this
   * device and a stable tracking beacon, so it comes from the system CSPRNG.
   */
  private fun randomBytes(count: Int): ByteArray =
    ByteArray(count).also { random.nextBytes(it) }

  private fun hex(bytes: ByteArray): String =
    bytes.joinToString("") { "%02x".format(it) }

  private fun describe(error: Throwable): String =
    error.message ?: error.javaClass.simpleName

  // -------------------------------------------------------------------------
  // Emitting
  // -------------------------------------------------------------------------

  /**
   * Events are posted to the main looper, never emitted from the BLE thread.
   *
   * A dropped event is not a cosmetic failure: it is a peer the UI never learns
   * about, or a payload that arrived on the radio and then evaporated. So the
   * failure is logged rather than swallowed, and - unless the thing that failed
   * was itself the error channel - reported on `onError` as well.
   */
  private fun emit(name: String, body: Bundle) {
    mainHandler.post { deliver(name, body) }
  }

  private fun deliver(name: String, body: Bundle) {
    try {
      sendEvent(name, body)
    } catch (error: Throwable) {
      Log.e(LOG_TAG, "sendEvent('$name') failed", error)
      if (name == "onError") return
      try {
        sendEvent(
          "onError",
          bundleOf(
            "code" to BleErrorCode.INTERNAL,
            "message" to "Failed to deliver '$name': ${describe(error)}"
          )
        )
      } catch (nested: Throwable) {
        Log.e(LOG_TAG, "sendEvent('onError') failed too", nested)
      }
    }
  }

  private fun emitError(code: String, message: String) {
    emit("onError", bundleOf("message" to message, "code" to code))
  }

  /**
   * A redundant BLE direction can fail while another direction to the same
   * logical peer succeeds moments later. Keep the failure visible until the
   * stack proves it can send again, then clear only this class of transient
   * error instead of leaving a successful connection labelled as broken.
   */
  private fun emitSendError(message: String) {
    sendErrorActive = true
    emitError(BleErrorCode.SEND_FAILED, message)
  }

  private fun noteSendSuccess() {
    if (!sendErrorActive) return
    sendErrorActive = false
    emit("onError", bundleOf("message" to "", "code" to BleErrorCode.SEND_FAILED))
  }

  /** Every failure both rejects the promise and surfaces on `onError`. */
  private fun failPromise(promise: Promise, code: String, message: String) {
    emitError(code, message)
    promise.reject(BleMeshException(code, message))
  }
}

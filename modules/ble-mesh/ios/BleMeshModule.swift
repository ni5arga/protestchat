// BleMeshModule.swift
//
// CoreBluetooth mesh transport for Expo, iOS side.
//
// IMPORTANT: this file is a *dumb byte pipe*. It must never learn anything about
// chat: no message parsing, no dedup of application messages, no storage, no
// crypto. Bytes in, bytes out, plus peer/link lifecycle events.
//
// The one thing above raw ATT it is allowed to do is *framing* — splitting a
// payload across MTU-sized writes and reassembling it. That is transport
// plumbing, not chat logic, and it cannot live anywhere else: the MTU is only
// known here, per link, and only after negotiation.
//
// Every device is simultaneously a GATT peripheral (advertising + serving) and a
// GATT central (scanning + connecting). There is no client/server role in a
// mesh. Two devices will frequently connect to each other in both directions at
// once; `resolveDuplicateLinks` picks one deterministically so both sides agree.
//
// FILE LAYOUT — why the radio is not the Module
//
// Expo's `Module` base class is a plain Swift class, not an NSObject subclass,
// and its initialiser is `required public init(appContext:)` marked unavailable
// for override. All three CoreBluetooth delegate protocols inherit
// `NSObjectProtocol`, which Swift will not let a non-NSObject class adopt
// ("cannot declare conformance to 'NSObjectProtocol' in Swift"). So the radio
// lives in `BleMeshRadio: NSObject`, which owns both managers, the link table
// and every delegate callback, and `BleMeshModule: Module` is a thin shell that
// holds one radio, forwards the AsyncFunctions and turns the radio's event
// callback into `sendEvent`. The radio therefore never imports Expo's event
// plumbing and can be reasoned about (or ported) on its own.

import CoreBluetooth
import ExpoModulesCore
import Foundation

// MARK: - Wire constants
//
// Duplicated verbatim in src/constants.ts and in the Kotlin module. Change all
// three or none — these are the interop contract between an iPhone and an
// Android phone standing next to each other.

private enum Wire {
  static let serviceUUID = CBUUID(string: "7B3C1A80-9F42-4E17-9A6D-2C5E8B1F0D31")
  static let inboundUUID = CBUUID(string: "7B3C1A81-9F42-4E17-9A6D-2C5E8B1F0D31")
  static let outboundUUID = CBUUID(string: "7B3C1A82-9F42-4E17-9A6D-2C5E8B1F0D31")

  static let headerLen = 8
  static let version: UInt8 = 0x01
  static let typeData: UInt8 = 0x00
  static let typeHello: UInt8 = 0x01

  static let maxMessageBytes = 32_768
  static let maxAssembliesPerPeer = 4
  static let assemblyTimeout: TimeInterval = 30
  static let defaultRotation: TimeInterval = 15 * 60
  static let tagBytes = 8
  static let advertisedTagBytes = 4
  static let helloTimeout: TimeInterval = 10
  static let peerStale: TimeInterval = 30

  /// How many tag bytes we put in *our own* advertisement, as hex.
  ///
  /// A BLE advertisement is 31 bytes. Flags cost 3 and a 128-bit service UUID
  /// costs 18, leaving 10 — and `CBAdvertisementDataLocalNameKey` spends 2 of
  /// those on its own AD header. Four bytes of tag is eight hex characters,
  /// which is exactly the remaining budget with nothing to spare: any field iOS
  /// decides to add for its own reasons truncates the name silently. Three bytes
  /// (six characters) leaves two bytes of slack, which is the difference between
  /// "the tag survives" and "the tag is chopped in a way we cannot detect".
  ///
  /// This is only a rotation *hint* — see `advertisementData()` — so trading two
  /// bytes of entropy for headroom costs nothing that matters.
  static let advertisedNameBytes = 3

  /// Floor until negotiation completes. ATT_MTU 23 minus the 3-byte opcode +
  /// handle. Never assume more than this before the peer tells us otherwise.
  static let minUsableWrite = 20

  /// How long a link may sit waiting for a "radio is ready again" callback
  /// before we assume the callback is never coming. See `Link.blockedAt`.
  static let blockedWatchdog: TimeInterval = 5
}

// MARK: - Errors

/// Coded error identifiers. Duplicated verbatim in the Android implementation.
private enum BleErrorCode {
  static let unsupported = "ERR_BLE_UNSUPPORTED"
  static let poweredOff = "ERR_BLE_POWERED_OFF"
  static let unauthorized = "ERR_BLE_UNAUTHORIZED"
  static let locationOff = "ERR_BLE_LOCATION_OFF"
  static let notStarted = "ERR_BLE_NOT_STARTED"
  static let unknownPeer = "ERR_BLE_UNKNOWN_PEER"
  static let notConnected = "ERR_BLE_NOT_CONNECTED"
  static let invalidPayload = "ERR_BLE_INVALID_PAYLOAD"
  static let payloadTooLarge = "ERR_BLE_PAYLOAD_TOO_LARGE"
  static let advertiseFailed = "ERR_BLE_ADVERTISE_FAILED"
  static let scanFailed = "ERR_BLE_SCAN_FAILED"
  static let connectFailed = "ERR_BLE_CONNECT_FAILED"
  static let sendFailed = "ERR_BLE_SEND_FAILED"
  static let internalError = "ERR_BLE_INTERNAL"
}

private func bleException(_ code: String, _ message: String) -> Exception {
  return Exception(name: "BleMeshException", description: message, code: code)
}

/// What the radio hands back when an operation cannot be completed. The radio
/// does not know about promises; the module turns this into a rejection *and* an
/// `onError` event, so the two surfaces always carry the same code and message.
private struct BleFailure {
  let code: String
  let message: String
}

// MARK: - Reassembly

/// One partially received message.
private final class Assembly {
  let count: Int
  let startedAt: Date
  var chunks: [Int: Data] = [:]
  var bytes = 0

  init(count: Int) {
    self.count = count
    self.startedAt = Date()
  }
}

/// Per-link inbound reassembly.
///
/// Everything here exists because the far side is an untrusted radio. A peer
/// that opens thousands of messages and never finishes them is the cheapest
/// possible denial of service against a phone, so the buffer is bounded three
/// separate ways: by concurrent messages, by bytes per message, and by age.
private final class Reassembler {
  private var assemblies: [UInt16: Assembly] = [:]

  /// Returns a complete payload, or nil if this chunk did not complete one.
  /// A partially reassembled payload is NEVER returned.
  func accept(messageId: UInt16, index: Int, count: Int, payload: Data) -> Data? {
    // A zero-chunk message is meaningless, and an index outside the declared
    // range is either a bug or an attempt to make us allocate a sparse array.
    guard count > 0, index >= 0, index < count else { return nil }

    // Single-chunk fast path: the overwhelming majority of control traffic, and
    // it never touches the assembly table, so a flood of small messages cannot
    // evict a large transfer in progress.
    if count == 1 {
      return payload.count <= Wire.maxMessageBytes ? payload : nil
    }

    sweep()

    let existing = assemblies[messageId]
    if let existing, existing.count != count {
      // The peer changed its mind about how long this message is. Either a
      // messageId wrapped into a live assembly or the peer is hostile; drop the
      // whole thing rather than splice two different messages together.
      assemblies.removeValue(forKey: messageId)
      return nil
    }

    let assembly: Assembly
    if let existing {
      assembly = existing
    } else {
      if assemblies.count >= Wire.maxAssembliesPerPeer {
        // Evict the oldest, not the newest. A flooder should not be able to lock
        // out a legitimate transfer that is already most of the way done — but
        // the oldest incomplete one is also the one most likely to be abandoned.
        if let oldest = assemblies.min(by: { $0.value.startedAt < $1.value.startedAt })?.key {
          assemblies.removeValue(forKey: oldest)
        }
      }
      assembly = Assembly(count: count)
      assemblies[messageId] = assembly
    }

    // Duplicate chunk: ignore silently. BLE notifications can be re-delivered,
    // and both link directions can carry the same message during a duplicate-
    // link race that has not been resolved yet.
    if assembly.chunks[index] != nil { return nil }

    if assembly.bytes + payload.count > Wire.maxMessageBytes {
      assemblies.removeValue(forKey: messageId)
      return nil
    }

    assembly.chunks[index] = payload
    assembly.bytes += payload.count

    guard assembly.chunks.count == assembly.count else { return nil }

    // Out-of-order arrival is normal; ordering happens here, at completion.
    var out = Data(capacity: assembly.bytes)
    for i in 0..<assembly.count {
      guard let piece = assembly.chunks[i] else {
        assemblies.removeValue(forKey: messageId)
        return nil
      }
      out.append(piece)
    }
    assemblies.removeValue(forKey: messageId)
    return out
  }

  func sweep() {
    let cutoff = Date().addingTimeInterval(-Wire.assemblyTimeout)
    for (id, assembly) in assemblies where assembly.startedAt < cutoff {
      assemblies.removeValue(forKey: id)
    }
  }

  func clear() {
    assemblies.removeAll()
  }
}

// MARK: - Link

/// One GATT link, in whichever direction it happens to have formed.
private final class Link {
  let peerId: String
  /// True when the remote device connected to *our* GATT server.
  let isIncoming: Bool

  /// Central role (we dialled out).
  var peripheral: CBPeripheral?
  var inboundCharacteristic: CBCharacteristic?

  /// Peripheral role (they dialled in and subscribed to our notify characteristic).
  var central: CBCentral?

  var usableWrite = Wire.minUsableWrite
  var remoteTag: String?
  var announced = false
  var helloSent = false
  let openedAt = Date()

  var nextMessageId: UInt16 = UInt16.random(in: 0...UInt16.max)
  let reassembler = Reassembler()

  /// Chunks waiting for the radio. BLE gives no back-pressure signal other than
  /// "not now", so an unthrottled write loop silently drops data on both
  /// platforms; every chunk goes through this queue.
  var pending: [Data] = []
  var blocked = false

  /// When `blocked` was last set. The whole pump depends on CoreBluetooth
  /// calling `peripheralIsReady(toSendWriteWithoutResponse:)` or
  /// `peripheralManagerIsReady(toUpdateSubscribers:)` back, and on some stacks
  /// that callback simply does not arrive — at which point the link goes silent
  /// forever with no error anywhere. Housekeeping watches this timestamp so the
  /// worst case is a slow link rather than a dead one.
  var blockedAt: Date?

  init(peerId: String, isIncoming: Bool) {
    self.peerId = peerId
    self.isIncoming = isIncoming
  }

  func markBlocked() {
    blocked = true
    if blockedAt == nil { blockedAt = Date() }
  }

  func markProgress() {
    blocked = false
    blockedAt = nil
  }
}

private struct Discovered {
  var peripheral: CBPeripheral
  var lastSeen: Date
  var advertisedTag: String
}

// MARK: - Radio

/// Everything that touches CoreBluetooth.
///
/// This is an `NSObject` because the three delegate protocols require it (see
/// the file header). It knows nothing about Expo: events leave through
/// `onEvent`, and operations report failure through a `BleFailure` completion
/// rather than a `Promise`.
private final class BleMeshRadio: NSObject {
  /// Every piece of mutable state below is touched only on this queue, including
  /// from both CoreBluetooth managers (which are constructed with it) and from
  /// every AsyncFunction. A serial queue rather than a lock because CoreBluetooth
  /// callbacks reenter and a recursive lock around this much state is how you get
  /// a deadlock you can only reproduce in a crowd.
  private let queue = DispatchQueue(label: "org.protestchat.blemesh", qos: .userInitiated)

  /// Called on `queue` for every event. The owner is responsible for getting it
  /// to the JS runtime on whatever thread that runtime demands.
  var onEvent: ((String, [String: Any]) -> Void)?

  private var central: CBCentralManager?
  private var peripheralManager: CBPeripheralManager?

  private var inboundCharacteristic: CBMutableCharacteristic?
  private var outboundCharacteristic: CBMutableCharacteristic?
  private var serviceAdded = false

  private var wantAdvertising = false
  private var wantScanning = false

  /// Current ephemeral identifier. See `rotate()`.
  private var localTag = Data()
  private var rotationInterval = Wire.defaultRotation
  private var rotationTimer: DispatchSourceTimer?
  private var housekeepingTimer: DispatchSourceTimer?

  private var links: [String: Link] = [:]
  /// CBPeripheral.identifier -> our peerId, so a re-discovered peer keeps its handle
  /// for as long as this app session lasts.
  private var peerIdByPeripheral: [UUID: String] = [:]
  private var discovered: [String: Discovered] = [:]

  private var lastPublishedState: String?

  // MARK: Public surface (called from the module, off `queue`)

  func startAdvertising(rotationMs: Double, completion: @escaping (BleFailure?) -> Void) {
    queue.async {
      self.ensureManagers()
      self.rotationInterval = rotationMs > 0 ? rotationMs / 1000 : Wire.defaultRotation
      self.wantAdvertising = true
      if self.localTag.isEmpty { self.localTag = Self.randomBytes(Wire.tagBytes) }
      self.startRotationTimer()
      self.startHousekeepingTimer()
      self.applyPeripheralState()
      completion(nil)
    }
  }

  func startScanning(completion: @escaping (BleFailure?) -> Void) {
    queue.async {
      self.ensureManagers()
      self.wantScanning = true
      if self.localTag.isEmpty { self.localTag = Self.randomBytes(Wire.tagBytes) }
      self.startHousekeepingTimer()
      self.applyCentralState()
      completion(nil)
    }
  }

  func stopAll(completion: @escaping (BleFailure?) -> Void) {
    queue.async {
      self.teardown()
      completion(nil)
    }
  }

  func connect(peerId: String, completion: @escaping (BleFailure?) -> Void) {
    queue.async {
      // Idempotent by contract: both devices will call this about each other
      // at the same moment, and a second call must not produce a second link
      // or an error the caller has to special-case.
      if self.links[peerId] != nil {
        completion(nil)
        return
      }
      guard let entry = self.discovered[peerId] else {
        completion(BleFailure(
          code: BleErrorCode.unknownPeer,
          message: "Unknown peer '\(peerId)'. It was never discovered, or it was already lost."
        ))
        return
      }
      guard let central = self.central, central.state == .poweredOn else {
        completion(BleFailure(
          code: BleErrorCode.notStarted,
          message: "Bluetooth central is not ready."
        ))
        return
      }
      entry.peripheral.delegate = self
      central.connect(entry.peripheral, options: nil)
      completion(nil)
    }
  }

  func disconnect(peerId: String, completion: @escaping (BleFailure?) -> Void) {
    queue.async {
      // Never fail on an absent peer — callers use this in cleanup paths.
      self.dropLink(peerId, announce: true)
      completion(nil)
    }
  }

  func send(peerId: String, payload: Data, completion: @escaping (BleFailure?) -> Void) {
    queue.async {
      guard let link = self.links[peerId], link.announced else {
        completion(BleFailure(
          code: BleErrorCode.notConnected,
          message: "Peer '\(peerId)' is not connected."
        ))
        return
      }
      guard payload.count <= Wire.maxMessageBytes else {
        completion(BleFailure(
          code: BleErrorCode.payloadTooLarge,
          message: "Payload of \(payload.count) bytes exceeds the \(Wire.maxMessageBytes) byte transport limit."
        ))
        return
      }
      guard self.enqueue(link: link, type: Wire.typeData, payload: payload) else {
        completion(BleFailure(
          code: BleErrorCode.sendFailed,
          message: "Payload does not fit the framing header's chunk count."
        ))
        return
      }
      self.pump(link)
      completion(nil)
    }
  }

  func status(completion: @escaping ([String: Any]) -> Void) {
    queue.async { completion(self.statusDictionary()) }
  }

  func requestAccess(completion: @escaping ([String: Any]) -> Void) {
    queue.async {
      // Constructing CoreBluetooth managers is the public iOS API for requesting
      // Bluetooth access. The state-change callback supplies the final result
      // after the system permission or power alert has been answered.
      self.ensureManagers()
      completion(self.statusDictionary())
    }
  }

  func isAvailable(completion: @escaping (Bool) -> Void) {
    queue.async { completion(self.currentState() == "ready") }
  }

  func rotateNow(completion: @escaping (BleFailure?) -> Void) {
    queue.async {
      self.rotate()
      completion(nil)
    }
  }

  /// Synchronous because it runs from `OnDestroy`, after which the module — and
  /// therefore the event sink — is gone.
  func destroy() {
    queue.sync { self.teardown() }
  }

  // MARK: - Manager lifecycle

  private func ensureManagers() {
    // Constructed lazily: instantiating either manager is what triggers the iOS
    // Bluetooth permission prompt, and an app that has not yet asked to use the
    // radio should not be prompting.
    if central == nil {
      central = CBCentralManager(
        delegate: self,
        queue: queue,
        options: [
          CBCentralManagerOptionShowPowerAlertKey: true,
          CBCentralManagerOptionRestoreIdentifierKey: "org.protestchat.central",
        ]
      )
    }
    if peripheralManager == nil {
      peripheralManager = CBPeripheralManager(
        delegate: self,
        queue: queue,
        options: [
          CBPeripheralManagerOptionShowPowerAlertKey: false,
          CBPeripheralManagerOptionRestoreIdentifierKey: "org.protestchat.peripheral",
        ]
      )
    }
  }

  private func applyCentralState() {
    guard let central, central.state == .poweredOn else { return }
    if wantScanning {
      // allowDuplicates is required, not an optimisation: CoreBluetooth has no
      // "peer lost" callback at all, so loss is inferred from silence, and a peer
      // that rotated its advertisement while we were already scanning would never
      // be re-reported without it. The battery cost is real and is the price of
      // knowing who is actually still in range.
      central.scanForPeripherals(
        withServices: [Wire.serviceUUID],
        options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
      )
    } else if central.isScanning {
      central.stopScan()
    }
  }

  private func applyPeripheralState() {
    guard let manager = peripheralManager, manager.state == .poweredOn else { return }

    if !serviceAdded {
      let inbound = CBMutableCharacteristic(
        type: Wire.inboundUUID,
        properties: [.write, .writeWithoutResponse],
        value: nil,
        permissions: [.writeable]
      )
      let outbound = CBMutableCharacteristic(
        type: Wire.outboundUUID,
        properties: [.notify],
        value: nil,
        permissions: [.readable]
      )
      let service = CBMutableService(type: Wire.serviceUUID, primary: true)
      service.characteristics = [inbound, outbound]
      inboundCharacteristic = inbound
      outboundCharacteristic = outbound
      manager.add(service)
      serviceAdded = true
    }

    if wantAdvertising {
      if manager.isAdvertising { manager.stopAdvertising() }
      manager.startAdvertising(advertisementData())
    } else if manager.isAdvertising {
      manager.stopAdvertising()
    }
  }

  /// What actually goes on the air.
  ///
  /// Exactly two things: the service UUID, and a hex string of three CSPRNG bytes.
  ///
  /// NOT the display name. NOT any part of the user's public key. NOT anything
  /// derived from either. The advertisement is readable by every radio in range
  /// including a police scanner, so it deliberately carries nothing that survives
  /// a rotation or that links back to a person. Peer identity is established by
  /// the sealed payloads at the mesh layer; this transport only ever deals in
  /// ephemeral, per-session handles.
  ///
  /// `CBAdvertisementDataLocalNameKey` is the only field CoreBluetooth lets an app
  /// control (service *data* is silently dropped on iOS), which is why the tag
  /// rides in the local name here and in the scan-response service data on
  /// Android. Both sides read whichever their peer publishes.
  ///
  /// BYTE BUDGET. 31 bytes total: 3 for flags, 18 for the 128-bit service UUID,
  /// 2 for the local name's AD header, leaving 8 for the name itself. Six hex
  /// characters fits with two bytes of slack, so an OS-added field truncates the
  /// slack instead of the tag. Even so the tag is treated as *advisory
  /// everywhere it is read*: a truncated or entirely absent local name degrades
  /// us to "cannot notice this peer rotated", never to "cannot see this peer" —
  /// the service UUID is what the scan filter matches on, and the authoritative
  /// full 8-byte tag arrives in-band in HELLO.
  private func advertisementData() -> [String: Any] {
    return [
      CBAdvertisementDataServiceUUIDsKey: [Wire.serviceUUID],
      CBAdvertisementDataLocalNameKey: Self.hex(localTag.prefix(Wire.advertisedNameBytes)),
    ]
  }

  // MARK: - Rotation

  private func startRotationTimer() {
    rotationTimer?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + rotationInterval, repeating: rotationInterval)
    timer.setEventHandler { [weak self] in self?.rotate() }
    timer.resume()
    rotationTimer = timer
  }

  /// Replaces the ephemeral identifier with fresh CSPRNG bytes.
  ///
  /// The new tag is NOT derivable from the old one — no counter, no hash chain,
  /// no key. That is the whole point: an observer who logged the previous tag
  /// must not be able to recognise the same device afterwards. Anything
  /// derivable, however cheap, would reduce this to a stable identifier with
  /// extra steps.
  ///
  /// Advertising is fully stopped and restarted rather than updated in place.
  /// The app cannot set the BLE link-layer address — that belongs to the OS —
  /// but tearing the advertising set down and building a new one is the only
  /// lever an app has to give the stack an opportunity to re-randomise it. Our
  /// rotation is necessary but not sufficient; see the README.
  ///
  /// Live links are deliberately NOT dropped. Cutting every link every fifteen
  /// minutes would gut the mesh, and a link already established is already
  /// correlated with us for its lifetime — rotating under it would buy nothing.
  private func rotate() {
    localTag = Self.randomBytes(Wire.tagBytes)
    if wantAdvertising, let manager = peripheralManager, manager.state == .poweredOn {
      manager.stopAdvertising()
      manager.startAdvertising(advertisementData())
    }
  }

  private func startHousekeepingTimer() {
    guard housekeepingTimer == nil else { return }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 5, repeating: 5)
    timer.setEventHandler { [weak self] in self?.housekeeping() }
    timer.resume()
    housekeepingTimer = timer
  }

  /// Ages out stale discoveries, un-HELLO'd links and abandoned reassemblies,
  /// and un-sticks any link whose flow-control callback never arrived.
  private func housekeeping() {
    let now = Date()

    for (peerId, entry) in discovered where now.timeIntervalSince(entry.lastSeen) > Wire.peerStale {
      discovered.removeValue(forKey: peerId)
      if links[peerId] == nil {
        emit("onPeerLost", ["id": peerId])
      }
    }

    for (peerId, link) in links {
      if !link.announced, now.timeIntervalSince(link.openedAt) > Wire.helloTimeout {
        // No HELLO means no transport identity, which means we can neither
        // deduplicate nor address it. Holding it open only burns one of the
        // handful of concurrent GATT links the OS will give us.
        dropLink(peerId, announce: false)
      } else {
        link.reassembler.sweep()
        checkPumpWatchdog(link, now: now)
      }
    }
  }

  /// The pump is entirely callback-driven, so a callback that never arrives is
  /// indistinguishable from a link with nothing to say — except that it never
  /// recovers. Whether any shipping stack actually drops
  /// `peripheralIsReady(toSendWriteWithoutResponse:)` or
  /// `peripheralManagerIsReady(toUpdateSubscribers:)` cannot be established
  /// without two phones and a lot of traffic; this makes the failure survivable
  /// either way. Clearing `blocked` and retrying costs at most one wasted
  /// `updateValue`, which the stack will simply refuse again.
  private func checkPumpWatchdog(_ link: Link, now: Date) {
    guard link.blocked, !link.pending.isEmpty, let since = link.blockedAt else { return }
    guard now.timeIntervalSince(since) > Wire.blockedWatchdog else { return }

    // Visible, not silent: a mesh that has quietly stopped forwarding is the
    // worst possible failure mode at a protest.
    emitError(
      code: BleErrorCode.sendFailed,
      message: "Link '\(link.peerId)' saw no flow-control callback for "
        + "\(Int(Wire.blockedWatchdog))s; retrying \(link.pending.count) queued chunk(s)."
    )
    link.markProgress()
    pump(link)
  }

  // MARK: - Framing

  /// Splits `payload` into chunks and queues them. Returns false if the payload
  /// cannot be expressed in the header's 16-bit chunk count.
  private func enqueue(link: Link, type: UInt8, payload: Data) -> Bool {
    let maxChunk = max(1, link.usableWrite - Wire.headerLen)
    let count = payload.isEmpty ? 1 : (payload.count + maxChunk - 1) / maxChunk
    guard count <= Int(UInt16.max) else { return false }

    let messageId = link.nextMessageId
    link.nextMessageId = messageId &+ 1

    // Normalised to a plain array first: a `Data` handed to us by CoreBluetooth
    // can be a slice whose startIndex is not 0, and slicing it with absolute
    // offsets then traps at runtime.
    let raw = [UInt8](payload)

    for index in 0..<count {
      let start = index * maxChunk
      let end = min(start + maxChunk, raw.count)
      var frame = Data(capacity: Wire.headerLen + (end - start))
      frame.append(Wire.version)
      frame.append(type)
      frame.append(UInt8(messageId >> 8))
      frame.append(UInt8(messageId & 0xff))
      frame.append(UInt8(index >> 8))
      frame.append(UInt8(index & 0xff))
      frame.append(UInt8(count >> 8))
      frame.append(UInt8(count & 0xff))
      if start < end { frame.append(contentsOf: raw[start..<end]) }
      link.pending.append(frame)
    }
    return true
  }

  /// Drains a link's queue as fast as the radio will accept.
  ///
  /// Both directions are back-pressured and neither reports it as an error:
  /// `canSendWriteWithoutResponse` goes false and `updateValue` returns false.
  /// Ignoring either silently discards chunks, which surfaces two layers up as a
  /// message that simply never arrives.
  private func pump(_ link: Link) {
    while !link.pending.isEmpty {
      let frame = link.pending[0]

      if link.isIncoming {
        guard let outbound = outboundCharacteristic,
              let manager = peripheralManager,
              let central = link.central
        else {
          link.pending.removeAll()
          link.markProgress()
          return
        }
        if !manager.updateValue(frame, for: outbound, onSubscribedCentrals: [central]) {
          // Transmit queue full. peripheralManagerIsReadyToUpdateSubscribers
          // will call us back — and if it does not, the watchdog will.
          link.markBlocked()
          return
        }
      } else {
        guard let peripheral = link.peripheral,
              let inbound = link.inboundCharacteristic
        else {
          link.pending.removeAll()
          link.markProgress()
          return
        }
        if inbound.properties.contains(.writeWithoutResponse) {
          if !peripheral.canSendWriteWithoutResponse {
            link.markBlocked()
            return
          }
          peripheral.writeValue(frame, for: inbound, type: .withoutResponse)
        } else {
          // No fast path on this peer. `.withResponse` is one round trip per
          // chunk — slow, but it is flow-controlled by the stack itself, so no
          // extra gating is needed here.
          peripheral.writeValue(frame, for: inbound, type: .withResponse)
        }
      }

      link.pending.removeFirst()
      link.markProgress()
    }
  }

  private func pumpAll() {
    for link in links.values where link.blocked || !link.pending.isEmpty {
      link.markProgress()
      pump(link)
    }
  }

  /// Feeds one received frame into a link. Called for every ATT write and every
  /// notification, from either role.
  private func receive(link: Link, frame: Data) {
    guard frame.count >= Wire.headerLen else { return }
    let bytes = [UInt8](frame)
    guard bytes[0] == Wire.version else { return }

    let type = bytes[1]
    let messageId = (UInt16(bytes[2]) << 8) | UInt16(bytes[3])
    let index = (Int(bytes[4]) << 8) | Int(bytes[5])
    let count = (Int(bytes[6]) << 8) | Int(bytes[7])
    let payload = Data(bytes[Wire.headerLen...])

    guard let complete = link.reassembler.accept(
      messageId: messageId, index: index, count: count, payload: payload
    ) else {
      // Incomplete, duplicate, out of bounds or over budget. Nothing goes up.
      return
    }

    switch type {
    case Wire.typeHello:
      handleHello(link: link, tag: complete)
    case Wire.typeData:
      guard link.announced else {
        // Data before HELLO is not addressable to anything. Drop rather than
        // emit a payload attributed to a peer handle nobody has been told about.
        return
      }
      emit("onPayload", ["peerId": link.peerId, "payloadBase64": complete.base64EncodedString()])
    default:
      // Unknown frame type from a future version. Ignore, do not disconnect —
      // an old build must stay usable in a mesh containing newer ones.
      break
    }
  }

  private func sendHello(_ link: Link) {
    guard !link.helloSent else { return }
    link.helloSent = true
    _ = enqueue(link: link, type: Wire.typeHello, payload: localTag)
    pump(link)
  }

  /// A link becomes addressable only once the peer has told us its ephemeral tag.
  ///
  /// This is the *only* identity that matters. The advertised tag is a hint that
  /// may be truncated, absent, or unreadable on one platform or the other; HELLO
  /// is in-band, full width, and symmetric, so a link that connects with no
  /// advertised tag at all still resolves normally here.
  private func handleHello(link: Link, tag: Data) {
    guard tag.count == Wire.tagBytes else {
      dropLink(link.peerId, announce: false)
      return
    }
    link.remoteTag = Self.hex(tag)

    if let loser = resolveDuplicateLinks(for: link) {
      dropLink(loser, announce: links[loser]?.announced == true)
      if loser == link.peerId { return }
    }

    guard !link.announced else { return }
    link.announced = true
    emit("onConnected", [
      "id": link.peerId,
      "name": "",
      "mtu": link.usableWrite,
      "isIncoming": link.isIncoming,
    ])
  }

  /// Two devices that discover each other simultaneously will both dial out, and
  /// both will succeed — one link in each direction, carrying the same traffic
  /// twice. Returns the peerId of the link to discard, or nil if there is no
  /// duplicate.
  ///
  /// The tie-break must be computed identically on both phones from information
  /// both hold, or they discard opposite links and end up with none. Both know
  /// their own tag and their peer's, so: the device with the lexicographically
  /// smaller tag keeps the link it dialled out on. On the other phone that same
  /// link is the inbound one, so both keep the same wire.
  private func resolveDuplicateLinks(for link: Link) -> String? {
    guard let tag = link.remoteTag else { return nil }
    guard let other = links.values.first(where: {
      $0.peerId != link.peerId && $0.remoteTag == tag
    }) else { return nil }

    let weAreSmaller = Self.hex(localTag) < tag
    let keeper = weAreSmaller
      ? (link.isIncoming ? other : link)
      : (link.isIncoming ? link : other)
    return keeper.peerId == link.peerId ? other.peerId : link.peerId
  }

  // MARK: - Link teardown

  private func dropLink(_ peerId: String, announce: Bool) {
    guard let link = links.removeValue(forKey: peerId) else { return }
    link.pending.removeAll()
    link.reassembler.clear()
    if let peripheral = link.peripheral, let central {
      central.cancelPeripheralConnection(peripheral)
    }
    if announce && link.announced {
      emit("onDisconnected", ["id": peerId])
    }
  }

  private func teardown() {
    rotationTimer?.cancel()
    rotationTimer = nil
    housekeepingTimer?.cancel()
    housekeepingTimer = nil
    wantAdvertising = false
    wantScanning = false

    if let central {
      if central.isScanning { central.stopScan() }
      for link in links.values {
        if let peripheral = link.peripheral {
          central.cancelPeripheralConnection(peripheral)
        }
      }
    }
    peripheralManager?.stopAdvertising()
    if serviceAdded {
      peripheralManager?.removeAllServices()
      serviceAdded = false
    }

    let announced = links.values.filter(\.announced).map(\.peerId)
    links.removeAll()
    discovered.removeAll()
    peerIdByPeripheral.removeAll()
    inboundCharacteristic = nil
    outboundCharacteristic = nil

    // Leaving the tag behind after a stop would leave the last advertised
    // identifier recoverable from memory for no benefit.
    localTag = Data()

    // Cancelling a connection does not deliver didDisconnectPeripheral, so
    // synthesise the terminal event. Callers must tolerate a disconnect for a
    // peer they already forgot.
    for peerId in announced {
      emit("onDisconnected", ["id": peerId])
    }
  }

  // MARK: - State

  private func currentState() -> String {
    let states = [central?.state, peripheralManager?.state].compactMap { $0 }
    if states.isEmpty { return "unknown" }
    // Worst state wins: both roles are required, so a device that can scan but
    // not advertise is not a usable mesh node.
    if states.contains(.unsupported) { return "unsupported" }
    if states.contains(.unauthorized) { return "unauthorized" }
    if states.contains(.poweredOff) { return "poweredOff" }
    if states.contains(.resetting) { return "resetting" }
    if states.contains(.unknown) { return "unknown" }
    return "ready"
  }

  private func statusDictionary() -> [String: Any] {
    let state = currentState()
    return ["state": state, "available": state == "ready", "message": Self.describe(state)]
  }

  private static func describe(_ state: String) -> String {
    switch state {
    case "ready": return ""
    case "poweredOff": return "Bluetooth is switched off. Turn it on in Control Centre or Settings."
    case "unauthorized": return "protestchat is not allowed to use Bluetooth. Enable it in Settings › Privacy › Bluetooth."
    case "unsupported": return "This device has no usable Bluetooth LE radio."
    case "resetting": return "The Bluetooth stack is restarting."
    default: return "Bluetooth state is not known yet."
    }
  }

  private func publishStateIfChanged() {
    let state = currentState()
    guard state != lastPublishedState else { return }
    lastPublishedState = state
    emit("onStateChange", statusDictionary())
    if state != "ready" && state != "unknown" {
      let code: String
      switch state {
      case "poweredOff": code = BleErrorCode.poweredOff
      case "unauthorized": code = BleErrorCode.unauthorized
      case "unsupported": code = BleErrorCode.unsupported
      default: code = BleErrorCode.internalError
      }
      emitError(code: code, message: Self.describe(state))
    }
  }

  // MARK: - Helpers

  private static func randomBytes(_ count: Int) -> Data {
    var bytes = [UInt8](repeating: 0, count: count)
    // SecRandomCopyBytes, not arc4random: the tag is the only thing standing
    // between this device and a stable tracking beacon, so it comes from the
    // system CSPRNG or not at all.
    if SecRandomCopyBytes(kSecRandomDefault, count, &bytes) != errSecSuccess {
      for i in 0..<count { bytes[i] = UInt8.random(in: 0...255) }
    }
    return Data(bytes)
  }

  private static func hex<C: Collection>(_ bytes: C) -> String where C.Element == UInt8 {
    return bytes.map { String(format: "%02x", $0) }.joined()
  }

  private func peerId(for peripheral: CBPeripheral) -> String {
    if let existing = peerIdByPeripheral[peripheral.identifier] { return existing }
    let minted = UUID().uuidString
    peerIdByPeripheral[peripheral.identifier] = minted
    return minted
  }

  private func link(for peripheral: CBPeripheral) -> Link? {
    guard let peerId = peerIdByPeripheral[peripheral.identifier] else { return nil }
    return links[peerId]
  }

  // MARK: - Emitting

  private func emit(_ name: String, _ body: [String: Any]) {
    onEvent?(name, body)
  }

  private func emitError(code: String, message: String) {
    emit("onError", ["message": message, "code": code])
  }
}

// MARK: - CBCentralManagerDelegate (scanning + outbound links)

extension BleMeshRadio: CBCentralManagerDelegate {
  func centralManagerDidUpdateState(_ manager: CBCentralManager) {
    publishStateIfChanged()
    applyCentralState()
  }

  func centralManager(_ manager: CBCentralManager, willRestoreState dict: [String: Any]) {
    // iOS relaunched the app to handle a BLE event. If we were scanning when the
    // OS terminated us, resume scanning so the mesh can discover peers again.
    // Reconnections happen through fresh discovery; restoring connected
    // peripherals is deliberately left to the next scan cycle to keep this path
    // simple and safe.
    if !wantScanning {
      wantScanning = true
    }
    applyCentralState()
  }

  func centralManager(
    _ manager: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    let id = peerId(for: peripheral)

    // Android peers publish the tag as service data; iOS peers publish it as the
    // local name, because that is the only advertisement field CoreBluetooth
    // exposes to an app. Read whichever is present.
    //
    // UNVERIFIED ON HARDWARE: that an iPhone reliably sees an Android peer's
    // scan-response service data, and that an Android phone reliably sees this
    // iPhone's local name, are both plausible-but-untested. The code is written
    // so that neither mattering is survivable: an empty tag here is not an
    // error, does not suppress the discovery, and does not stop `connect()`.
    // The consequence of a missing tag is exactly one thing — we cannot notice
    // that this peer rotated — and HELLO re-establishes identity on every link
    // regardless.
    var tag = ""
    if let serviceData = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data],
       let bytes = serviceData[Wire.serviceUUID], !bytes.isEmpty {
      tag = Self.hex(bytes.prefix(Wire.advertisedTagBytes))
    } else if let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String,
              !name.isEmpty {
      // Taken verbatim, however short. A local name truncated by the OS is still
      // stable for as long as the peer does not rotate, so it remains a usable
      // rotation hint; it is never parsed, compared across peers, or trusted.
      tag = name
    }

    let known = discovered[id]
    discovered[id] = Discovered(peripheral: peripheral, lastSeen: Date(), advertisedTag: tag)

    // Report only the first sighting and any sighting after the peer rotated.
    // With allowDuplicates the radio hands us the same advertisement several
    // times a second, and forwarding all of it would turn `onPeerFound` into a
    // firehose the JS layer has to debounce itself.
    if known == nil || (known!.advertisedTag != tag && !tag.isEmpty) {
      emit("onPeerFound", ["id": id, "name": ""])
    }
  }

  func centralManager(_ manager: CBCentralManager, didConnect peripheral: CBPeripheral) {
    let id = peerId(for: peripheral)
    if links[id] == nil {
      links[id] = Link(peerId: id, isIncoming: false)
    }
    links[id]?.peripheral = peripheral
    peripheral.delegate = self
    peripheral.discoverServices([Wire.serviceUUID])
  }

  func centralManager(
    _ manager: CBCentralManager,
    didFailToConnect peripheral: CBPeripheral,
    error: Error?
  ) {
    let id = peerId(for: peripheral)
    dropLink(id, announce: true)
    emitError(
      code: BleErrorCode.connectFailed,
      message: "Failed to connect to '\(id)': \(error?.localizedDescription ?? "unknown")"
    )
  }

  func centralManager(
    _ manager: CBCentralManager,
    didDisconnectPeripheral peripheral: CBPeripheral,
    error: Error?
  ) {
    let id = peerId(for: peripheral)
    dropLink(id, announce: true)
  }
}

// MARK: - CBPeripheralDelegate (central role: talking to a peer's server)

extension BleMeshRadio: CBPeripheralDelegate {
  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard error == nil, let service = peripheral.services?.first(where: { $0.uuid == Wire.serviceUUID })
    else {
      central?.cancelPeripheralConnection(peripheral)
      return
    }
    peripheral.discoverCharacteristics([Wire.inboundUUID, Wire.outboundUUID], for: service)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverCharacteristicsFor service: CBService,
    error: Error?
  ) {
    guard error == nil, let link = link(for: peripheral) else {
      central?.cancelPeripheralConnection(peripheral)
      return
    }

    for characteristic in service.characteristics ?? [] {
      switch characteristic.uuid {
      case Wire.inboundUUID:
        link.inboundCharacteristic = characteristic
      case Wire.outboundUUID:
        peripheral.setNotifyValue(true, for: characteristic)
      default:
        break
      }
    }

    guard link.inboundCharacteristic != nil else {
      central?.cancelPeripheralConnection(peripheral)
      return
    }

    // iOS negotiates the MTU for us; there is no requestMtu equivalent. Read the
    // result rather than assuming it — until this line runs, 20 bytes is all we
    // are entitled to.
    let negotiated = peripheral.maximumWriteValueLength(for: .withoutResponse)
    link.usableWrite = max(Wire.minUsableWrite, negotiated)

    sendHello(link)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard error == nil,
          characteristic.uuid == Wire.outboundUUID,
          let data = characteristic.value,
          let link = link(for: peripheral)
    else { return }
    receive(link: link, frame: data)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didWriteValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard let link = link(for: peripheral) else { return }
    if let error {
      emitError(
        code: BleErrorCode.sendFailed,
        message: "Write to '\(link.peerId)' failed: \(error.localizedDescription)"
      )
    }
    link.markProgress()
    pump(link)
  }

  func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
    guard let link = link(for: peripheral) else { return }
    link.markProgress()
    pump(link)
  }
}

// MARK: - CBPeripheralManagerDelegate (peripheral role: serving inbound centrals)

extension BleMeshRadio: CBPeripheralManagerDelegate {
  func peripheralManagerDidUpdateState(_ manager: CBPeripheralManager) {
    publishStateIfChanged()
    applyPeripheralState()
  }

  func peripheralManager(_ manager: CBPeripheralManager, willRestoreState dict: [String: Any]) {
    // iOS relaunched the app to handle a BLE event. If we were advertising when
    // the OS terminated us, resume advertising so peers can still find us.
    if !wantAdvertising {
      wantAdvertising = true
    }
    applyPeripheralState()
  }

  func peripheralManagerDidStartAdvertising(
    _ manager: CBPeripheralManager,
    error: Error?
  ) {
    if let error {
      emitError(
        code: BleErrorCode.advertiseFailed,
        message: "Failed to start advertising: \(error.localizedDescription)"
      )
    }
  }

  func peripheralManager(
    _ manager: CBPeripheralManager,
    central: CBCentral,
    didSubscribeTo characteristic: CBCharacteristic
  ) {
    guard characteristic.uuid == Wire.outboundUUID else { return }
    let id = central.identifier.uuidString
    let link = links[id] ?? Link(peerId: id, isIncoming: true)
    link.central = central
    // The central negotiated the MTU on connect; this is the honest ceiling for
    // a notification and is not the same number as the write ceiling.
    link.usableWrite = max(Wire.minUsableWrite, central.maximumUpdateValueLength)
    links[id] = link
    sendHello(link)
  }

  func peripheralManager(
    _ manager: CBPeripheralManager,
    central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    guard characteristic.uuid == Wire.outboundUUID else { return }
    dropLink(central.identifier.uuidString, announce: true)
  }

  /// The documented CoreBluetooth contract for this callback, verified against
  /// the current `CBPeripheralManagerDelegate` header:
  ///
  ///  - `requests` contains one or more `CBATTRequest`s, all from the same
  ///    central, and they are an atomic unit.
  ///  - You must call `respond(to:withResult:)` **exactly once**, passing the
  ///    **first** request in the array, even though the array may hold several.
  ///    Responding to the others is an API misuse; responding to none stalls
  ///    that central's ATT queue until it times out.
  ///  - The result you pass applies to the whole batch, so if any request in the
  ///    batch is unacceptable the correct answer is a single error response —
  ///    not a partial success.
  ///
  /// This is *not* an assumption about who sent the write. Even a peer that used
  /// write-without-response is answered here; the response is consumed by the
  /// local stack rather than put on the air, so answering costs nothing and not
  /// answering is what hangs.
  func peripheralManager(
    _ manager: CBPeripheralManager,
    didReceiveWrite requests: [CBATTRequest]
  ) {
    guard let first = requests.first else { return }

    // Validate the whole batch before applying any of it, so the single response
    // we are allowed to send is honest about what happened.
    var result: CBATTError.Code = .success
    for request in requests {
      if request.characteristic.uuid != Wire.inboundUUID {
        result = .writeNotPermitted
      } else if request.offset != 0 {
        // Long writes are not part of the contract: our own framing already keeps
        // every write inside one MTU, so a non-zero offset can only come from a
        // peer doing something we did not ask for.
        result = .invalidOffset
      }
    }

    if result == .success {
      for request in requests {
        guard let value = request.value else { continue }
        let id = request.central.identifier.uuidString
        let link = links[id] ?? {
          // A peer may write before it subscribes. Create the link so the frame is
          // not lost; `didSubscribeTo` will fill in the CBCentral.
          let created = Link(peerId: id, isIncoming: true)
          created.central = request.central
          created.usableWrite = max(Wire.minUsableWrite, request.central.maximumUpdateValueLength)
          links[id] = created
          return created
        }()
        receive(link: link, frame: value)
      }
    }

    manager.respond(to: first, withResult: result)
  }

  func peripheralManagerIsReady(toUpdateSubscribers manager: CBPeripheralManager) {
    pumpAll()
  }
}

// MARK: - Module

/// The Expo surface. Holds one radio, forwards every AsyncFunction to it, and is
/// the only thing in this file that knows what a `Promise` or an event emitter
/// is. See the file header for why the CoreBluetooth work cannot live here.
public final class BleMeshModule: Module {
  private let radio = BleMeshRadio()

  public func definition() -> ModuleDefinition {
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

    OnCreate {
      // All events reach JS on the main queue; CoreBluetooth callbacks arrive on
      // the radio's own serial queue and must not touch the JS runtime directly.
      self.radio.onEvent = { [weak self] name, body in
        DispatchQueue.main.async { self?.sendEvent(name, body) }
      }
    }

    OnDestroy {
      self.radio.onEvent = nil
      self.radio.destroy()
    }

    AsyncFunction("startAdvertising") { (rotationMs: Double, promise: Promise) in
      self.radio.startAdvertising(rotationMs: rotationMs) { self.settle(promise, $0) }
    }

    AsyncFunction("startScanning") { (promise: Promise) in
      self.radio.startScanning { self.settle(promise, $0) }
    }

    AsyncFunction("stopAll") { (promise: Promise) in
      self.radio.stopAll { self.settle(promise, $0) }
    }

    AsyncFunction("connect") { (peerId: String, promise: Promise) in
      self.radio.connect(peerId: peerId) { self.settle(promise, $0) }
    }

    AsyncFunction("disconnect") { (peerId: String, promise: Promise) in
      self.radio.disconnect(peerId: peerId) { self.settle(promise, $0) }
    }

    AsyncFunction("send") { (peerId: String, payloadBase64: String, promise: Promise) in
      guard let data = Data(base64Encoded: payloadBase64, options: [.ignoreUnknownCharacters]) else {
        self.settle(promise, BleFailure(
          code: BleErrorCode.invalidPayload,
          message: "payloadBase64 is not valid base64."
        ))
        return
      }
      self.radio.send(peerId: peerId, payload: data) { self.settle(promise, $0) }
    }

    AsyncFunction("getStatus") { (promise: Promise) in
      self.radio.status { promise.resolve($0) }
    }

    AsyncFunction("requestAccess") { (promise: Promise) in
      self.radio.requestAccess { promise.resolve($0) }
    }

    AsyncFunction("isAvailable") { (promise: Promise) in
      self.radio.isAvailable { promise.resolve($0) }
    }

    AsyncFunction("rotateNow") { (promise: Promise) in
      self.radio.rotateNow { self.settle(promise, $0) }
    }
  }

  /// Every failure both rejects the promise and surfaces on `onError`, so a
  /// global error surface can observe failures without wrapping every call.
  private func settle(_ promise: Promise, _ failure: BleFailure?) {
    guard let failure else {
      promise.resolve(nil)
      return
    }
    DispatchQueue.main.async {
      self.sendEvent("onError", ["message": failure.message, "code": failure.code])
    }
    promise.reject(bleException(failure.code, failure.message))
  }
}

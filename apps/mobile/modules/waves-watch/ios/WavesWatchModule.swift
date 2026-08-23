import ExpoModulesCore
import WatchConnectivity

// The phone end of the Apple Watch relay.
//
// A thin WatchConnectivity bridge: it forwards messages the watch sends up to
// JS (`onWatchMessage`) and sends the phone's replies back down. All product
// logic lives in JS (`src/lib/watch/bridge.tsx`); this only moves dictionaries.
//
// UNVERIFIED: written on Windows with no Xcode. Build on a Mac/EAS before trust.
public final class WavesWatchModule: Module {
  private let relay = WatchRelay()

  public func definition() -> ModuleDefinition {
    Name("WavesWatch")

    Events("onWatchMessage", "onWatchSendFailed")

    OnCreate {
      self.relay.onMessage = { [weak self] payload in
        self?.sendEvent("onWatchMessage", ["payload": payload])
      }
      // A queued transfer reports its outcome asynchronously and long after
      // `sendToWatch` returned, so JS cannot learn of the failure from the call
      // itself — this is the only signal it gets. `t` is the message kind that
      // was lost, so the bridge can decide what to redo.
      self.relay.onSendFailed = { [weak self] kind in
        self?.sendEvent("onWatchSendFailed", ["t": kind ?? ""])
      }
      self.relay.activate()
    }

    Function("isReachable") { () -> Bool in
      self.relay.isReachable
    }

    Function("sendToWatch") { (payload: [String: Any]) -> Void in
      self.relay.send(payload)
    }
  }
}

// Kept out of the Module subclass so the WCSessionDelegate conformance (which
// Objective-C must see) is isolated from Expo's generics.
private final class WatchRelay: NSObject, WCSessionDelegate {
  var onMessage: (([String: Any]) -> Void)?
  /** Called with the `t` of a queued payload that never reached the watch. */
  var onSendFailed: ((String?) -> Void)?

  private var session: WCSession? {
    WCSession.isSupported() ? WCSession.default : nil
  }

  var isReachable: Bool {
    session?.isReachable ?? false
  }

  func activate() {
    guard let session else { return }
    session.delegate = self
    session.activate()
  }

  func send(_ payload: [String: Any]) {
    guard let session, session.activationState == .activated else { return }
    if session.isReachable {
      // Live path; if it fails, fall back to a queued transfer rather than
      // dropping the message.
      session.sendMessage(payload, replyHandler: nil) { _ in
        session.transferUserInfo(payload)
      }
    } else {
      // Guaranteed, FIFO delivery on the watch's next wake — unlike
      // updateApplicationContext, which keeps only the newest payload and would
      // coalesce independent recent/ack/settings messages into one.
      session.transferUserInfo(payload)
    }
  }

  // MARK: WCSessionDelegate

  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    onMessage?(message)
  }

  // The queued counterpart of the live sendMessage path — delivered on wake.
  func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
    onMessage?(userInfo)
  }

  /**
   * The outcome of a `transferUserInfo`.
   *
   * Without this method WatchConnectivity has nowhere to report a failed
   * transfer and logs that the delegate does not implement it, so every queued
   * payload that never arrived was dropped in silence. That matters most for
   * `recent`: the bridge remembers the last list it sent and skips re-sending an
   * identical one, so a lost transfer would otherwise leave the watch showing a
   * stale list until the list itself changed.
   *
   * `error` is terminal — WatchConnectivity has already retried the queued
   * transfer on its own — so this reports the loss rather than re-sending, which
   * against an unpaired or deleted watch would only fail again in a loop.
   */
  func session(
    _ session: WCSession,
    didFinish userInfoTransfer: WCSessionUserInfoTransfer,
    error: Error?
  ) {
    guard error != nil else { return }
    onSendFailed?(userInfoTransfer.userInfo["t"] as? String)
  }

  func session(
    _ session: WCSession,
    activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {}

  func sessionDidBecomeInactive(_ session: WCSession) {}

  func sessionDidDeactivate(_ session: WCSession) {
    // Re-activate so a switched watch reconnects.
    session.activate()
  }
}

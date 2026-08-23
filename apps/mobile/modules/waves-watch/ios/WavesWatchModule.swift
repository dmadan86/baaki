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

    Events("onWatchMessage")

    OnCreate {
      self.relay.onMessage = { [weak self] payload in
        self?.sendEvent("onWatchMessage", ["payload": payload])
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
    guard let session else { return }
    if session.isReachable {
      session.sendMessage(payload, replyHandler: nil, errorHandler: nil)
    } else {
      // Not reachable right now — leave it as the latest context the watch
      // reads on its next wake. Replaces any older pending context.
      try? session.updateApplicationContext(payload)
    }
  }

  // MARK: WCSessionDelegate

  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    onMessage?(message)
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

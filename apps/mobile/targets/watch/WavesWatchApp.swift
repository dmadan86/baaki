import SwiftUI
import WatchConnectivity

// Waves — Apple Watch companion.
//
// Sends intents to the paired phone over WatchConnectivity and shows what the
// phone relays back. The wire shapes match @waves/core's relay contract:
//   watch → phone: {t:"quickAdd"|"voiceAdd"|"requestRecent", ...}
//   phone → watch: {t:"recent", items:[...]} | {t:"settings", recentCount} | {t:"ack", ok}
//
// UNVERIFIED: authored on Windows without Xcode. Build on a Mac/EAS before trust.

// MARK: - Relay

struct RecentItem: Identifiable {
  let id = UUID()
  let title: String
  let subtitle: String
  let amountText: String
  let whenText: String
}

final class WatchRelay: NSObject, ObservableObject, WCSessionDelegate {
  @Published var recent: [RecentItem] = []
  @Published var recentCount: Int = 5
  @Published var lastAckOk: Bool? = nil
  @Published var reachable: Bool = false

  private var session: WCSession? { WCSession.isSupported() ? WCSession.default : nil }

  override init() {
    super.init()
    guard let session else { return }
    session.delegate = self
    session.activate()
  }

  func requestRecent() {
    send(["t": "requestRecent", "count": recentCount])
  }

  func quickAdd(amountMinor: Int, currency: String, note: String) {
    send(["t": "quickAdd", "amountMinor": String(amountMinor), "currency": currency, "note": note])
  }

  func voiceAdd(_ transcript: String) {
    send(["t": "voiceAdd", "transcript": transcript])
  }

  private func send(_ message: [String: Any]) {
    guard let session, session.activationState == .activated else { return }
    if session.isReachable {
      session.sendMessage(message, replyHandler: nil, errorHandler: nil)
    } else {
      try? session.updateApplicationContext(message)
    }
  }

  // MARK: WCSessionDelegate

  func session(
    _ session: WCSession,
    activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    DispatchQueue.main.async {
      self.reachable = session.isReachable
      if activationState == .activated { self.requestRecent() }
    }
  }

  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    handle(message)
  }

  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    handle(applicationContext)
  }

  func sessionReachabilityDidChange(_ session: WCSession) {
    DispatchQueue.main.async { self.reachable = session.isReachable }
  }

  private func handle(_ message: [String: Any]) {
    guard let t = message["t"] as? String else { return }
    DispatchQueue.main.async {
      switch t {
      case "recent":
        let raw = message["items"] as? [[String: Any]] ?? []
        self.recent = raw.map {
          RecentItem(
            title: $0["title"] as? String ?? "",
            subtitle: $0["subtitle"] as? String ?? "",
            amountText: $0["amountText"] as? String ?? "",
            whenText: $0["whenText"] as? String ?? ""
          )
        }
      case "settings":
        if let n = message["recentCount"] as? Int { self.recentCount = n }
      case "ack":
        self.lastAckOk = message["ok"] as? Bool ?? false
      default:
        break
      }
    }
  }
}

// MARK: - App

@main
struct WavesWatchApp: App {
  @StateObject private var relay = WatchRelay()

  var body: some Scene {
    WindowGroup {
      HomeView().environmentObject(relay)
    }
  }
}

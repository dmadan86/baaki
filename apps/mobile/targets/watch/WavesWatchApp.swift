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
  @Published var currency: String = "USD"
  @Published var lastAckOk: Bool? = nil
  @Published var reachable: Bool = false
  /// An expense this watch sent that WatchConnectivity could not deliver.
  @Published var lastSendFailed: Bool = false

  private var session: WCSession? { WCSession.isSupported() ? WCSession.default : nil }

  override init() {
    super.init()
    guard let session else { return }
    session.delegate = self
    session.activate()
  }

  // Matches @waves/core's WATCH_RELAY_VERSION so a version-skewed phone rejects us.
  private let relayVersion = 1

  func requestRecent() {
    send(["t": "requestRecent", "count": recentCount])
  }

  func quickAdd(amountMinor: Int, currency: String, note: String) {
    lastSendFailed = false
    send([
      "t": "quickAdd",
      // A stable id per intent so a transport retry of the same tap is
      // idempotent on the phone rather than creating a duplicate expense.
      "id": UUID().uuidString,
      "amountMinor": String(amountMinor),
      "currency": currency,
      "note": note,
    ])
  }

  func voiceAdd(_ transcript: String) {
    lastSendFailed = false
    send(["t": "voiceAdd", "id": UUID().uuidString, "transcript": transcript])
  }

  private func send(_ message: [String: Any]) {
    guard let session, session.activationState == .activated else { return }
    var payload = message
    payload["version"] = relayVersion
    if session.isReachable {
      session.sendMessage(payload, replyHandler: nil) { _ in
        session.transferUserInfo(payload)
      }
    } else {
      session.transferUserInfo(payload)
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

  func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
    handle(userInfo)
  }

  func sessionReachabilityDidChange(_ session: WCSession) {
    DispatchQueue.main.async { self.reachable = session.isReachable }
  }

  /**
   * The outcome of a `transferUserInfo` — the path every intent takes whenever
   * the phone is not reachable, which on a wrist is most of the time.
   *
   * Without this method WatchConnectivity has nowhere to report a failed
   * transfer, so an expense spoken or dialled here could disappear between the
   * watch and the phone with nothing shown: the view dismisses on tap and the
   * only other signal, `ack`, comes from a phone that never got the message.
   *
   * Only the intents that carry an expense raise the warning. A lost
   * `requestRecent` costs nothing — the list simply stays as it was, which the
   * Recent screen already shows honestly.
   */
  func session(
    _ session: WCSession,
    didFinish userInfoTransfer: WCSessionUserInfoTransfer,
    error: Error?
  ) {
    let kind = userInfoTransfer.userInfo["t"] as? String
    guard kind == "quickAdd" || kind == "voiceAdd" else { return }
    let failed = error != nil
    DispatchQueue.main.async { self.lastSendFailed = failed }
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
        if let c = message["currency"] as? String, !c.isEmpty { self.currency = c }
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

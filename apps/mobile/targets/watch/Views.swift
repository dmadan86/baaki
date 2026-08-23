import SwiftUI

// Waves watch UI — Home, Quick-add, Voice, Recent.
// Brand purple accent; glanceable rows; Digital-Crown scroll on the list.
// UNVERIFIED: authored without Xcode.

private let accent = Color(red: 0.478, green: 0.353, blue: 0.973)

struct HomeView: View {
  @EnvironmentObject var relay: WatchRelay

  var body: some View {
    NavigationStack {
      List {
        NavigationLink(destination: VoiceView()) {
          Label("Speak", systemImage: "mic.fill")
        }
        NavigationLink(destination: QuickAddView()) {
          Label("Quick add", systemImage: "plus.circle.fill")
        }
        NavigationLink(destination: RecentView()) {
          Label("Recent", systemImage: "clock.fill")
        }
      }
      .tint(accent)
      .navigationTitle("Waves")
      .onAppear { relay.requestRecent() }
    }
  }
}

struct RecentView: View {
  @EnvironmentObject var relay: WatchRelay

  var body: some View {
    Group {
      if relay.recent.isEmpty {
        VStack(spacing: 6) {
          Image(systemName: "clock").font(.title3).foregroundStyle(.secondary)
          Text("Nothing yet").font(.footnote).foregroundStyle(.secondary)
        }
      } else {
        List(relay.recent) { item in
          VStack(alignment: .leading, spacing: 2) {
            HStack {
              Text(item.title).font(.body).lineLimit(1)
              Spacer()
              Text(item.amountText).font(.body).bold()
            }
            Text("\(item.subtitle) · \(item.whenText)")
              .font(.caption2)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
      }
    }
    .navigationTitle("Recent")
    .onAppear { relay.requestRecent() }
  }
}

struct QuickAddView: View {
  @EnvironmentObject var relay: WatchRelay
  @Environment(\.dismiss) private var dismiss
  @State private var amount: Double = 0

  var body: some View {
    VStack(spacing: 10) {
      Text(String(format: "%.0f", amount))
        .font(.system(size: 44, weight: .bold))
        .focusable(true)
        .digitalCrownRotation($amount, from: 0, through: 1_000_000, by: 1, sensitivity: .medium)
      Button {
        // The crown value is a major-unit amount; convert to minor (×100) for
        // the two-decimal currencies the phone defaults to. The phone re-derives
        // the real currency; this sends its default.
        relay.quickAdd(amountMinor: Int(amount * 100), currency: relay.currency, note: "")
        dismiss()
      } label: {
        Text("Add").frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .tint(accent)
      .disabled(amount <= 0)
    }
    .padding()
    .navigationTitle("Quick add")
  }
}

struct VoiceView: View {
  @EnvironmentObject var relay: WatchRelay
  @Environment(\.dismiss) private var dismiss
  @State private var text: String = ""

  var body: some View {
    VStack(spacing: 12) {
      Text("Say what you spent")
        .font(.footnote)
        .foregroundStyle(.secondary)
      // On watchOS a TextField offers Scribble and Dictation; the mic there is
      // the "speak an expense" path. The phone parses the transcript.
      TextField("e.g. add 500 to Goa", text: $text)
        .textFieldStyle(.plain)
      Button {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        relay.voiceAdd(t)
        dismiss()
      } label: {
        Label("Send", systemImage: "paperplane.fill").frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .tint(accent)
      .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    .padding()
    .navigationTitle("Speak")
  }
}

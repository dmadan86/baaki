/**
 * The Apple Watch companion — a watchOS SwiftUI app target.
 *
 * A thin client: it sends quick-add / voice / request-recent intents to the
 * paired phone over WatchConnectivity and renders what the phone relays back
 * (see `@waves/core`'s relay contract and `src/lib/watch/bridge.tsx`). No ledger
 * logic lives here. The Android sibling is the `:wear` module emitted by
 * plugins/withWavesWear.js; the shared transport is the WavesWatch Expo module.
 *
 * UNVERIFIED: authored on Windows without Xcode — build on a Mac/EAS to prove it.
 * Needs the companion bundle id app.waves.mobile.watchkitapp under the Apple
 * Developer account.
 *
 * @type {import('@bacons/apple-targets/app.plugin').Config}
 */
module.exports = {
  type: 'watch',
  name: 'Waves',
  deploymentTarget: '10.0',
  colors: {
    $accent: '#7A5AF8',
  },
};

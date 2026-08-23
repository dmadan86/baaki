package expo.modules.waveswatch

import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService

/**
 * Receives messages the Wear app sends on the `/waves` path and hands them to
 * the live [WavesWatchModule], which forwards them to JS. If the app process is
 * not running there is no live module, and the message is dropped — the v1
 * "phone must be awake" limitation.
 */
class WavesWatchListenerService : WearableListenerService() {
  override fun onMessageReceived(event: MessageEvent) {
    if (event.path != WavesWatchModule.PATH) return
    WavesWatchModule.deliver(String(event.data, Charsets.UTF_8))
  }
}

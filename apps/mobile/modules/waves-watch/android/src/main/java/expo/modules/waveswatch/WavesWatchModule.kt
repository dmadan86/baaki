package expo.modules.waveswatch

import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.Wearable
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject

/**
 * The phone end of the Wear OS relay.
 *
 * Forwards messages the Wear app sends (via [WavesWatchListenerService]) up to
 * JS as `onWatchMessage`, and sends the phone's replies back down the Wearable
 * Data Layer. All product logic is in JS (src/lib/watch/bridge.tsx); this only
 * moves JSON dictionaries.
 *
 * A single live instance is published for the listener service to reach — which
 * ties delivery to the app process being alive. Headless delivery (app killed)
 * is a deliberate v1 non-goal.
 *
 * UNVERIFIED: written on Windows with no Android build; compile on an emulator
 * before trust.
 */
class WavesWatchModule : Module() {
  companion object {
    const val PATH = "/waves"

    @Volatile
    private var live: WavesWatchModule? = null

    /** Called by the listener service on the main process. */
    fun deliver(json: String) {
      live?.emit(json)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("WavesWatch")

    Events("onWatchMessage")

    OnCreate { live = this@WavesWatchModule }

    OnDestroy {
      if (live === this@WavesWatchModule) live = null
    }

    Function("isReachable") {
      // A precise reachability probe is asynchronous on Wear; the send path
      // tolerates no connected node, so report true and let the send decide.
      true
    }

    AsyncFunction("sendToWatch") { payload: Map<String, Any?> ->
      val context = appContext.reactContext ?: return@AsyncFunction
      val bytes = JSONObject(payload).toString().toByteArray(Charsets.UTF_8)
      val nodeClient = Wearable.getNodeClient(context)
      val messageClient = Wearable.getMessageClient(context)
      // Runs on the module's async queue, off the JS thread, so awaiting is fine.
      val nodes = Tasks.await(nodeClient.connectedNodes)
      for (node in nodes) {
        messageClient.sendMessage(node.id, PATH, bytes)
      }
    }
  }

  private fun emit(json: String) {
    sendEvent("onWatchMessage", mapOf("payload" to jsonToMap(JSONObject(json))))
  }
}

/** Recursively turn org.json values into the plain maps/lists Expo can bridge. */
internal fun jsonToMap(obj: JSONObject): Map<String, Any?> {
  val out = HashMap<String, Any?>()
  for (key in obj.keys()) {
    out[key] = normalise(obj.get(key))
  }
  return out
}

private fun normalise(value: Any?): Any? =
  when (value) {
    is JSONObject -> jsonToMap(value)
    is JSONArray -> (0 until value.length()).map { normalise(value.get(it)) }
    JSONObject.NULL -> null
    else -> value
  }

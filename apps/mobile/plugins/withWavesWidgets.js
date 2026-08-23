/**
 * Home-screen launcher widgets for Android.
 *
 * Three 1×1 widgets — quick-add an expense, scan a receipt, and voice — each a
 * single tap that fires the deep link the app already resolves (`/capture`,
 * `/capture?scan=…`, `/voice`, routed through `+native-intent.ts`). They hold
 * no data and run no timeline; they are pure shortcuts, the home-screen sibling
 * of the app-icon quick actions the app already ships.
 *
 * Why a config plugin rather than checked-in native files: `android/` is
 * generated and gitignored (CNG / prebuild), so anything dropped there by hand
 * is erased on the next `expo prebuild`. Every widget source — the manifest
 * receivers, the `res/` xml/layout/drawable, and the Kotlin providers — is
 * therefore emitted here so prebuild reproduces it. Modelled structurally on
 * `withShortNativeBuildPath.js`, the repo's other local plugin.
 *
 * The iOS half of this feature lives in `targets/widgets` (@bacons/apple-targets).
 */

const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod, AndroidConfig } = require('expo/config-plugins');

/** The three widgets. `scheme` matches the primary app scheme in app.json. */
const SCHEME = 'waves';
const WIDGETS = [
  {
    className: 'QuickExpenseWidget',
    key: 'quick',
    label: 'Add expense',
    link: `${SCHEME}:///capture`,
    icon: 'ic_widget_add',
    // Distinct request code so the three PendingIntents never collide.
    requestCode: 1,
  },
  {
    className: 'ScanReceiptWidget',
    key: 'scan',
    label: 'Scan receipt',
    // A static nonce is enough here: the widget always launches the app cold or
    // to the foreground, where the capture screen's consume-once scan guard
    // fires cleanly. The live-session re-entry the dashboard button worries
    // about (a fresh Date.now nonce) cannot happen from a home-screen tap.
    link: `${SCHEME}:///capture?scan=1`,
    icon: 'ic_widget_scan',
    requestCode: 2,
  },
  {
    className: 'VoiceWidget',
    key: 'voice',
    label: 'Voice',
    link: `${SCHEME}:///voice`,
    icon: 'ic_widget_voice',
    requestCode: 3,
  },
];

const ACCENT = '#7A5AF8';

// --- res/ file bodies ---------------------------------------------------------

const BACKGROUND_DRAWABLE = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
  <solid android:color="${ACCENT}" />
  <corners android:radius="24dp" />
</shape>
`;

const ICONS = {
  ic_widget_add: `<vector xmlns:android="http://schemas.android.com/apk/res/android"
  android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#FFFFFF" android:pathData="M11,5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
</vector>
`,
  ic_widget_scan: `<vector xmlns:android="http://schemas.android.com/apk/res/android"
  android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#FFFFFF" android:pathData="M4,4h4v2H6v2H4zM16,4h4v4h-2V6h-2zM4,16h2v2h2v2H4zM18,16h2v4h-4v-2h2zM7,11h10v2H7z" />
</vector>
`,
  ic_widget_voice: `<vector xmlns:android="http://schemas.android.com/apk/res/android"
  android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#FFFFFF" android:pathData="M12,3a3,3 0,0 1,3 3v6a3,3 0,0 1,-6 0V6a3,3 0,0 1,3 -3zM5,11h2a5,5 0,0 0,10 0h2a7,7 0,0 1,-6 6.92V21h-2v-3.08A7,7 0,0 1,5 11z" />
</vector>
`,
};

const widgetInfoXml = (widget) => `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
  android:minWidth="40dp"
  android:minHeight="40dp"
  android:targetCellWidth="1"
  android:targetCellHeight="1"
  android:resizeMode="none"
  android:widgetCategory="home_screen"
  android:previewImage="@drawable/${widget.icon}"
  android:initialLayout="@layout/widget_${widget.key}" />
`;

const widgetLayoutXml = (widget) => `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
  android:id="@+id/widget_root"
  android:layout_width="match_parent"
  android:layout_height="match_parent"
  android:orientation="vertical"
  android:gravity="center"
  android:padding="8dp"
  android:background="@drawable/widget_background">
  <ImageView
    android:layout_width="28dp"
    android:layout_height="28dp"
    android:src="@drawable/${widget.icon}"
    android:contentDescription="${widget.label}" />
  <TextView
    android:layout_width="wrap_content"
    android:layout_height="wrap_content"
    android:layout_marginTop="4dp"
    android:text="${widget.label}"
    android:textColor="#FFFFFF"
    android:textSize="11sp"
    android:maxLines="1"
    android:ellipsize="end" />
</LinearLayout>
`;

const kotlinProvider = (widget, pkg) => `package ${pkg}.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import ${pkg}.R

/**
 * ${widget.label} — a launcher widget that opens ${widget.link}.
 * Generated by plugins/withWavesWidgets.js; do not edit under android/.
 */
class ${widget.className} : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    for (id in ids) {
      val views = RemoteViews(context.packageName, R.layout.widget_${widget.key})
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse("${widget.link}")).apply {
        setPackage(context.packageName)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      }
      val pending = PendingIntent.getActivity(
        context,
        ${widget.requestCode},
        intent,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      views.setOnClickPendingIntent(R.id.widget_root, pending)
      manager.updateAppWidget(id, views)
    }
  }
}
`;

// --- manifest -----------------------------------------------------------------

function addReceivers(androidManifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  application.receiver = application.receiver ?? [];

  for (const widget of WIDGETS) {
    const name = `.widget.${widget.className}`;
    // Idempotent: prebuild may run this more than once.
    const exists = application.receiver.some((r) => r?.$?.['android:name'] === name);
    if (exists) continue;

    application.receiver.push({
      $: { 'android:name': name, 'android:exported': 'true', 'android:label': widget.label },
      'intent-filter': [
        {
          action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }],
        },
      ],
      'meta-data': [
        {
          $: {
            'android:name': 'android.appwidget.provider',
            'android:resource': `@xml/widget_${widget.key}_info`,
          },
        },
      ],
    });
  }
  return androidManifest;
}

// --- file writing -------------------------------------------------------------

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeNativeSources(projectRoot, pkg) {
  const main = path.join(projectRoot, 'android', 'app', 'src', 'main');
  const res = path.join(main, 'res');

  writeFile(path.join(res, 'drawable', 'widget_background.xml'), BACKGROUND_DRAWABLE);
  for (const [name, body] of Object.entries(ICONS)) {
    writeFile(path.join(res, 'drawable', `${name}.xml`), body);
  }

  const kotlinDir = path.join(main, 'java', ...pkg.split('.'), 'widget');
  for (const widget of WIDGETS) {
    writeFile(path.join(res, 'xml', `widget_${widget.key}_info.xml`), widgetInfoXml(widget));
    writeFile(path.join(res, 'layout', `widget_${widget.key}.xml`), widgetLayoutXml(widget));
    writeFile(path.join(kotlinDir, `${widget.className}.kt`), kotlinProvider(widget, pkg));
  }
}

// --- plugin -------------------------------------------------------------------

module.exports = function withWavesWidgets(config) {
  config = withAndroidManifest(config, (cfg) => {
    cfg.modResults = addReceivers(cfg.modResults);
    return cfg;
  });

  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const pkg = cfg.android?.package;
      if (!pkg) throw new Error('withWavesWidgets: android.package is not set');
      writeNativeSources(cfg.modRequest.projectRoot, pkg);
      return cfg;
    },
  ]);

  return config;
};

// Exposed for the plugin's unit test (test/withWavesWidgets.test.ts). Not part
// of the plugin's runtime contract.
module.exports._internals = {
  WIDGETS,
  addReceivers,
  writeNativeSources,
  widgetInfoXml,
  widgetLayoutXml,
  kotlinProvider,
  ICONS,
  BACKGROUND_DRAWABLE,
};

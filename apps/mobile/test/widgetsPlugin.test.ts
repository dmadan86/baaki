import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// The config plugin is plain JS; pull out the internals it exposes for testing.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { _internals } = require('../plugins/withWavesWidgets.js');
const { WIDGETS, addReceivers, writeNativeSources } = _internals as {
  WIDGETS: Array<{ className: string; key: string; label: string; link: string; icon: string }>;
  addReceivers: (m: unknown) => { manifest: { application: Array<{ receiver?: unknown[] }> } };
  writeNativeSources: (projectRoot: string, pkg: string) => void;
};

const PKG = 'app.waves.mobile';

/** A minimal parsed AndroidManifest, the shape expo's manifest mods pass around. */
function emptyManifest() {
  return {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android', package: PKG },
      application: [{ $: { 'android:name': '.MainApplication' } }],
    },
  };
}

describe('withWavesWidgets — manifest receivers', () => {
  it('adds one exported receiver per widget, each wired to its provider xml', () => {
    const manifest = emptyManifest();
    const out = addReceivers(manifest);
    const receivers = out.manifest.application[0].receiver as Array<{
      $: Record<string, string>;
      'intent-filter': Array<{ action: Array<{ $: Record<string, string> }> }>;
      'meta-data': Array<{ $: Record<string, string> }>;
    }>;

    expect(receivers).toHaveLength(WIDGETS.length);

    for (const widget of WIDGETS) {
      const receiver = receivers.find((r) => r.$['android:name'] === `.widget.${widget.className}`);
      expect(receiver, `receiver for ${widget.className}`).toBeTruthy();
      expect(receiver!.$['android:exported']).toBe('true');
      expect(receiver!['intent-filter'][0].action[0].$['android:name']).toBe(
        'android.appwidget.action.APPWIDGET_UPDATE',
      );
      expect(receiver!['meta-data'][0].$['android:resource']).toBe(
        `@xml/widget_${widget.key}_info`,
      );
    }
  });

  it('is idempotent — a second prebuild does not duplicate receivers', () => {
    const manifest = emptyManifest();
    addReceivers(manifest);
    const out = addReceivers(manifest);
    expect(out.manifest.application[0].receiver).toHaveLength(WIDGETS.length);
  });
});

describe('withWavesWidgets — emitted native sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'waves-widgets-'));
  writeNativeSources(root, PKG);
  const main = join(root, 'android', 'app', 'src', 'main');
  const read = (p: string) => readFileSync(join(main, p), 'utf8');

  it('writes the shared background and one icon per widget', () => {
    expect(existsSync(join(main, 'res', 'drawable', 'widget_background.xml'))).toBe(true);
    for (const widget of WIDGETS) {
      expect(existsSync(join(main, 'res', 'drawable', `${widget.icon}.xml`))).toBe(true);
    }
  });

  it('writes a provider-info, layout, and Kotlin provider per widget', () => {
    for (const widget of WIDGETS) {
      expect(existsSync(join(main, 'res', 'xml', `widget_${widget.key}_info.xml`))).toBe(true);
      expect(existsSync(join(main, 'res', 'layout', `widget_${widget.key}.xml`))).toBe(true);
      const kotlin = join(main, 'java', ...PKG.split('.'), 'widget', `${widget.className}.kt`);
      expect(existsSync(kotlin)).toBe(true);
    }
  });

  it('each Kotlin provider targets its package, layout, and deep link', () => {
    for (const widget of WIDGETS) {
      const kotlin = readFileSync(
        join(main, 'java', ...PKG.split('.'), 'widget', `${widget.className}.kt`),
        'utf8',
      );
      expect(kotlin).toContain(`package ${PKG}.widget`);
      expect(kotlin).toContain(`import ${PKG}.R`);
      expect(kotlin).toContain(`R.layout.widget_${widget.key}`);
      expect(kotlin).toContain(`Uri.parse("${widget.link}")`);
      // Immutable pending intents are mandatory from Android 12.
      expect(kotlin).toContain('FLAG_IMMUTABLE');
    }
  });

  it('the scan widget carries the consume-once nonce the capture screen expects', () => {
    const scan = WIDGETS.find((w) => w.key === 'scan')!;
    expect(scan.link).toBe('waves:///capture?scan=1');
  });

  it('the info xml points back at its own layout', () => {
    for (const widget of WIDGETS) {
      const info = read(join('res', 'xml', `widget_${widget.key}_info.xml`));
      expect(info).toContain(`@layout/widget_${widget.key}`);
      expect(info).toContain('home_screen');
    }
  });

  it('each layout roots on widget_root so the tap target resolves', () => {
    for (const widget of WIDGETS) {
      const layout = read(join('res', 'layout', `widget_${widget.key}.xml`));
      expect(layout).toContain('@+id/widget_root');
      expect(layout).toContain(`@drawable/${widget.icon}`);
    }
  });
});

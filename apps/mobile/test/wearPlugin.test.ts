import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { _internals } = require('../plugins/withWavesWear.js');
const {
  WEAR_PACKAGE,
  APPLICATION_ID,
  MARKER,
  settingsWithInclude,
  buildscriptWithCompose,
  writeWearModule,
} = _internals as {
  WEAR_PACKAGE: string;
  APPLICATION_ID: string;
  MARKER: string;
  settingsWithInclude: (contents: string) => string;
  buildscriptWithCompose: (contents: string) => string;
  writeWearModule: (projectRoot: string) => void;
};

describe('withWavesWear — settings.gradle include', () => {
  it("adds a single include ':wear' and is idempotent", () => {
    const base = "rootProject.name = 'app'\n";
    const once = settingsWithInclude(base);
    expect(once).toContain("include ':wear'");
    expect(once).toContain(MARKER);
    // A second prebuild must not append it again.
    expect(settingsWithInclude(once)).toBe(once);
  });
});

describe('withWavesWear — Compose compiler classpath', () => {
  const root = `buildscript {
    dependencies {
        classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')
    }
}`;

  it('adds the compose-compiler plugin next to kotlin-gradle-plugin, once', () => {
    const once = buildscriptWithCompose(root);
    expect(once).toContain('org.jetbrains.kotlin:compose-compiler-gradle-plugin');
    expect(once).toContain("classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')");
    // Idempotent across prebuilds.
    expect(buildscriptWithCompose(once)).toBe(once);
    // Exactly one insertion.
    expect(once.match(/compose-compiler-gradle-plugin/g)).toHaveLength(1);
  });
});

describe('withWavesWear — emitted :wear module', () => {
  const root = mkdtempSync(join(tmpdir(), 'waves-wear-'));
  writeWearModule(root);
  const wear = join(root, 'android', 'wear');
  const pkgDir = join(wear, 'src', 'main', 'java', ...WEAR_PACKAGE.split('.'));

  it('writes the module build.gradle, manifest and Kotlin sources', () => {
    expect(existsSync(join(wear, 'build.gradle'))).toBe(true);
    expect(existsSync(join(wear, 'src', 'main', 'AndroidManifest.xml'))).toBe(true);
    for (const file of ['MainActivity.kt', 'WearRelay.kt', 'PhoneListenerService.kt']) {
      expect(existsSync(join(pkgDir, file))).toBe(true);
    }
  });

  it('the build.gradle is a standalone Wear application with the right id', () => {
    const gradle = readFileSync(join(wear, 'build.gradle'), 'utf8');
    expect(gradle).toContain('com.android.application');
    expect(gradle).toContain(`applicationId "${APPLICATION_ID}"`);
    expect(gradle).toContain('play-services-wearable');
    expect(gradle).toContain('androidx.wear.compose');
  });

  it('the manifest declares a standalone watch app and the /waves listener', () => {
    const xml = readFileSync(join(wear, 'src', 'main', 'AndroidManifest.xml'), 'utf8');
    expect(xml).toContain('android.hardware.type.watch');
    expect(xml).toContain('com.google.android.wearable.standalone');
    expect(xml).toContain('com.google.android.gms.wearable.MESSAGE_RECEIVED');
    expect(xml).toContain('pathPrefix="/waves"');
  });

  it('the relay client and phone listener agree on the /waves path', () => {
    const relay = readFileSync(join(pkgDir, 'WearRelay.kt'), 'utf8');
    const listener = readFileSync(join(pkgDir, 'PhoneListenerService.kt'), 'utf8');
    expect(relay).toContain('const val PATH = "/waves"');
    expect(relay).toContain(`package ${WEAR_PACKAGE}`);
    expect(listener).toContain('WearRelay.onMessage');
    // The three intents the phone bridge understands.
    for (const t of ['quickAdd', 'voiceAdd', 'requestRecent']) {
      expect(relay).toContain(`"t", "${t}"`);
    }
  });
});

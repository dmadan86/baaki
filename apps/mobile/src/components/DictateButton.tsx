/**
 * The mic, or nothing at all.
 *
 * `expo-speech-recognition` is a native module, and its JS calls
 * `requireNativeModule('ExpoSpeechRecognition')` at the top of the file — which
 * **throws** in any binary compiled before the module was added. Because
 * expo-router loads every route file to build the route tree, that throw does
 * not cost you the microphone: it costs you the whole app, at launch, with a
 * red screen naming a component nobody was looking at.
 *
 * So the import lives in `DictateVoice` and is reached from here inside a
 * `try`. A phone whose binary knows about the module gets the mic; a dev client
 * or a store build from before it gets a text field, exactly as it had before.
 * Both of those are correct behaviour — the wrong one is a ledger that will not
 * open.
 *
 * Web gets nothing on purpose. Browsers do have a speech API, but it is
 * Google's servers behind it, and this repo uses the web build to check screens
 * rather than to ship them.
 */

import { Platform } from 'react-native';

import type { DictateProps } from './DictateVoice';

type DictateComponent = (props: DictateProps) => React.ReactNode;

const Voice: DictateComponent | null = (() => {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    // Deliberately require, not import: an import is hoisted and would run at
    // module load, which is the thing being avoided.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require('./DictateVoice') as { DictateVoice: DictateComponent };
    return loaded.DictateVoice;
  } catch {
    // The binary predates the native module. Nothing to say about it here —
    // the field still works, and README says which build fixes it.
    return null;
  }
})();

export type { DictateProps };

export function DictateButton(props: DictateProps) {
  if (!Voice) return null;
  return <Voice {...props} />;
}

// The WavesWatch native transport (WatchConnectivity on iOS, the Wearable Data
// Layer on Android). This local Expo module carries no public JS surface — the
// app talks to it through `src/lib/watch/nativeModule.ts`, which resolves the
// native module optionally so builds without it stay safe no-ops. Autolinking
// discovers the module from expo-module.config.json; this file only marks the
// package as a module directory.
export {};

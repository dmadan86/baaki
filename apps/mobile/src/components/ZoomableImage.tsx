import { useEffect, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { Image as RNImage, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { AnnotationOverlay } from '@/components/AnnotationOverlay';
import { containRect, type Annotations } from '@/lib/annotations';
import { clampZoomPoint, naturalSizeForUri, type NaturalImageSize } from '@/lib/zoomMath';

const AnimatedImage = Animated.createAnimatedComponent(Image);

/**
 * An image you can pinch to zoom, drag to pan, and double-tap to reset to fit.
 *
 * Deliberately self-contained: the gestures live on shared values so the pan and
 * zoom stay on the UI thread, and the whole thing resets to fit on a double tap
 * so a person who zoomed in can always get back out. Clamped to a sane range so
 * the image can neither shrink to a dot nor fly off screen.
 *
 * Shared by the saved-receipt viewer and the capture screen's pre-save preview,
 * so a bill looks and behaves the same before and after the row exists.
 */
export function ZoomableImage({
  uri,
  onZoomChange,
  annotations,
}: {
  uri: string;
  /** Fires when the image crosses between fit (1×) and zoomed (>1×). A pager uses
   *  it to stop swiping between pages while a page is zoomed in. */
  onZoomChange?: (zoomed: boolean) => void;
  /** Pen/text markup to draw over the image, tracking it through zoom/pan. When
   *  present the image is sized to its exact fit rectangle so the overlay lines
   *  up with the pixels; without it the plain full-box behaviour is unchanged. */
  annotations?: Annotations;
}): React.JSX.Element {
  const { width, height } = useWindowDimensions();
  const boxHeight = height * 0.8;

  // The image's natural size anchors both pan bounds and, when present, overlay
  // placement. Resolved once per uri; until then the rect falls back to the box.
  const [natural, setNatural] = useState<NaturalImageSize | null>(null);
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  const reportZoom = (zoomed: boolean) => onZoomChange?.(zoomed);

  // Hold the latest callback so the uri-reset effect can report the return to
  // fit without depending on onZoomChange (that would reset zoom whenever the
  // caller re-creates the callback).
  const onZoomChangeRef = useRef(onZoomChange);
  useEffect(() => {
    onZoomChangeRef.current = onZoomChange;
  }, [onZoomChange]);

  useEffect(() => {
    let active = true;
    scale.set(1);
    savedScale.set(1);
    translateX.set(0);
    translateY.set(0);
    savedX.set(0);
    savedY.set(0);
    // A reused page (the gallery keys pages by index) can swap uri while still
    // zoomed; tell the pager we are back at fit so it re-enables paging.
    onZoomChangeRef.current?.(false);
    RNImage.getSize(
      uri,
      (w, h) => active && setNatural({ uri, size: { w, h } }),
      () => active && setNatural(null),
    );
    return () => {
      active = false;
    };
  }, [savedScale, savedX, savedY, scale, translateX, translateY, uri]);

  const naturalSize = naturalSizeForUri(natural, uri);
  const rect = containRect({ w: width, h: boxHeight }, naturalSize ?? { w: 0, h: 0 });

  useEffect(() => {
    const clamped = clampZoomPoint(
      { x: translateX.get(), y: translateY.get() },
      { width, height: boxHeight },
      { width: rect.w, height: rect.h },
      scale.get(),
    );
    translateX.set(clamped.x);
    translateY.set(clamped.y);
    savedX.set(clamped.x);
    savedY.set(clamped.y);
  }, [boxHeight, rect.h, rect.w, savedX, savedY, scale, translateX, translateY, width]);

  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      // Clamp between fit (1) and 5×, so it can neither vanish nor over-magnify.
      const next = Math.min(Math.max(savedScale.get() * event.scale, 1), 5);
      scale.set(next);
    })
    .onEnd(() => {
      savedScale.set(scale.get());
      if (scale.get() <= 1) {
        translateX.set(withTiming(0));
        translateY.set(withTiming(0));
        savedX.set(0);
        savedY.set(0);
        runOnJS(reportZoom)(false);
      } else {
        const clamped = clampZoomPoint(
          { x: translateX.get(), y: translateY.get() },
          { width, height: boxHeight },
          { width: rect.w, height: rect.h },
          scale.get(),
        );
        translateX.set(withTiming(clamped.x));
        translateY.set(withTiming(clamped.y));
        savedX.set(clamped.x);
        savedY.set(clamped.y);
        runOnJS(reportZoom)(true);
      }
    });

  const pan = Gesture.Pan()
    .onUpdate((event) => {
      // Panning only makes sense once zoomed in; at fit it stays put.
      if (scale.get() <= 1) return;
      const clamped = clampZoomPoint(
        { x: savedX.get() + event.translationX, y: savedY.get() + event.translationY },
        { width, height: boxHeight },
        { width: rect.w, height: rect.h },
        scale.get(),
      );
      translateX.set(clamped.x);
      translateY.set(clamped.y);
    })
    .onEnd(() => {
      const clamped = clampZoomPoint(
        { x: translateX.get(), y: translateY.get() },
        { width, height: boxHeight },
        { width: rect.w, height: rect.h },
        scale.get(),
      );
      translateX.set(withTiming(clamped.x));
      translateY.set(withTiming(clamped.y));
      savedX.set(clamped.x);
      savedY.set(clamped.y);
    });

  // Double-tap toggles zoom: from fit it magnifies to a fixed level centred on
  // the point tapped (so a tap on a total zooms to that total, the Photos/Maps
  // behaviour), and from any zoomed state it returns to fit. Translate lives in
  // screen space (it is the outermost transform), so keeping the tapped point
  // still means shifting by -(target-1) × its offset from the view centre.
  const DOUBLE_TAP_SCALE = 2.5;
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((event) => {
      if (scale.get() > 1) {
        scale.set(withTiming(1));
        savedScale.set(1);
        translateX.set(withTiming(0));
        translateY.set(withTiming(0));
        savedX.set(0);
        savedY.set(0);
        runOnJS(reportZoom)(false);
        return;
      }
      const dx = event.x - width / 2;
      const dy = event.y - height / 2;
      const target = clampZoomPoint(
        { x: -(DOUBLE_TAP_SCALE - 1) * dx, y: -(DOUBLE_TAP_SCALE - 1) * dy },
        { width, height: boxHeight },
        { width: rect.w, height: rect.h },
        DOUBLE_TAP_SCALE,
      );
      scale.set(withTiming(DOUBLE_TAP_SCALE));
      savedScale.set(DOUBLE_TAP_SCALE);
      translateX.set(withTiming(target.x));
      translateY.set(withTiming(target.y));
      savedX.set(target.x);
      savedY.set(target.y);
      runOnJS(reportZoom)(true);
    });

  const composed = Gesture.Simultaneous(pinch, pan, doubleTap);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.get() },
      { translateY: translateY.get() },
      { scale: scale.get() },
    ],
  }));

  // Without an overlay: the original, unchanged full-box image. With one: size
  // the image to its fit rectangle and lay the overlay over the same rectangle,
  // both inside the zoom transform so they magnify together.
  if (!annotations) {
    return (
      <GestureDetector gesture={composed}>
        <Animated.View style={{ flex: 1, justifyContent: 'center' }} collapsable={false}>
          <AnimatedImage
            source={{ uri }}
            style={[{ width, height: boxHeight }, animatedStyle]}
            contentFit="contain"
            transition={150}
          />
        </Animated.View>
      </GestureDetector>
    );
  }

  return (
    <GestureDetector gesture={composed}>
      <Animated.View
        style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}
        collapsable={false}
      >
        <Animated.View style={[{ width: rect.w, height: rect.h }, animatedStyle]}>
          <Image
            source={{ uri }}
            style={{ width: rect.w, height: rect.h }}
            contentFit="contain"
            transition={150}
          />
          <AnnotationOverlay annotations={annotations} width={rect.w} height={rect.h} />
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

import { Image } from 'expo-image';
import { useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

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
export function ZoomableImage({ uri }: { uri: string }): React.JSX.Element {
  const { width, height } = useWindowDimensions();

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

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
      }
    });

  const pan = Gesture.Pan()
    .onUpdate((event) => {
      // Panning only makes sense once zoomed in; at fit it stays put.
      if (scale.get() <= 1) return;
      translateX.set(savedX.get() + event.translationX);
      translateY.set(savedY.get() + event.translationY);
    })
    .onEnd(() => {
      savedX.set(translateX.get());
      savedY.set(translateY.get());
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      scale.set(withTiming(1));
      savedScale.set(1);
      translateX.set(withTiming(0));
      translateY.set(withTiming(0));
      savedX.set(0);
      savedY.set(0);
    });

  const composed = Gesture.Simultaneous(pinch, pan, doubleTap);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.get() },
      { translateY: translateY.get() },
      { scale: scale.get() },
    ],
  }));

  return (
    <GestureDetector gesture={composed}>
      <Animated.View style={{ flex: 1, justifyContent: 'center' }} collapsable={false}>
        <AnimatedImage
          source={{ uri }}
          style={[{ width, height: height * 0.8 }, animatedStyle]}
          contentFit="contain"
          transition={150}
        />
      </Animated.View>
    </GestureDetector>
  );
}

/**
 * The receipt markup editor (A46): draw on a bill with a pen and drop text
 * notes, then save. Non-destructive — it produces an {@link Annotations} overlay
 * in normalised image coordinates; the image bytes are never touched, so the
 * markup stays editable and renders the same everywhere.
 *
 * Drawing is on the View responder API (the JS thread) rather than a worklet
 * gesture: a receipt scribble is low-frequency, and keeping the points in React
 * state is what lets undo, the live preview and the saved overlay all read from
 * one source. The tap-to-place text path shares the same normalised space.
 *
 * The overlay must line up with the image at every size, so everything is scaled
 * off the *displayed* image rectangle (letterboxed inside the screen via
 * `contain`), computed from the image's natural size — the same rectangle the
 * read-only {@link AnnotationOverlay} uses.
 */

import { useEffect, useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image as ExpoImage } from 'expo-image';
import {
  ActivityIndicator,
  Image as RNImage,
  Modal,
  Pressable,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import { IconButton, iconSize, Row, Text, useTheme } from '@waves/ui';

import { AnnotationOverlay } from '@/components/AnnotationOverlay';
import {
  ANNOT_COLORS,
  containRect,
  EMPTY_ANNOTATIONS,
  isEmptyAnnotations,
  type AnnotStroke,
  type AnnotText,
  type Annotations,
} from '@/lib/annotations';
import { useStrings } from '@/i18n';

/** Default pen width and text size, as a fraction of the image's smaller edge. */
const PEN_WIDTH = 0.006;
const TEXT_SIZE = 0.05;

type Action = { kind: 'stroke'; stroke: AnnotStroke } | { kind: 'text'; text: AnnotText };

export function ReceiptAnnotator({
  uri,
  initial,
  saving,
  onCancel,
  onSave,
}: {
  uri: string;
  initial: Annotations;
  saving: boolean;
  onCancel: () => void;
  onSave: (annotations: Annotations) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();

  const [history, setHistory] = useState<Action[]>(() => [
    ...initial.strokes.map((stroke): Action => ({ kind: 'stroke', stroke })),
    ...initial.texts.map((text): Action => ({ kind: 'text', text })),
  ]);
  const [mode, setMode] = useState<'pen' | 'text'>('pen');
  const [color, setColor] = useState(ANNOT_COLORS[0] as string);
  const [live, setLive] = useState<number[] | null>(null);
  const [pending, setPending] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState('');

  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  // Memoised so the drawn rectangle is a stable value while a stroke is in
  // progress (box/natural do not change mid-gesture); the draw handlers below
  // scale their points by it.
  const rect = useMemo(() => containRect(box, natural), [box, natural]);

  // Resolve the image's natural size so the letterbox rectangle is right; the
  // remote/local URI both answer `getSize`.
  useEffect(() => {
    let active = true;
    RNImage.getSize(
      uri,
      (w, h) => active && setNatural({ w, h }),
      () => active && setNatural({ w: 1, h: 1 }),
    );
    return () => {
      active = false;
    };
  }, [uri]);

  // Freehand drawing via the View responder API, inline rather than a memoised
  // PanResponder: the handlers close over the current rect/colour/live points
  // and read no refs, so they satisfy the React Compiler. The in-progress stroke
  // lives in `live` state; the release commits the last-rendered points, which
  // is the latest set since every move re-rendered.
  const norm = (v: number, span: number) => Math.min(1, Math.max(0, v / span));
  const drawHandlers = {
    onStartShouldSetResponder: () => rect.w > 0 && rect.h > 0,
    onMoveShouldSetResponder: () => rect.w > 0 && rect.h > 0,
    onResponderGrant: (e: { nativeEvent: { locationX: number; locationY: number } }) => {
      setLive([norm(e.nativeEvent.locationX, rect.w), norm(e.nativeEvent.locationY, rect.h)]);
    },
    onResponderMove: (e: { nativeEvent: { locationX: number; locationY: number } }) => {
      const nx = norm(e.nativeEvent.locationX, rect.w);
      const ny = norm(e.nativeEvent.locationY, rect.h);
      setLive((prev) => (prev ? [...prev, nx, ny] : [nx, ny]));
    },
    onResponderRelease: () => {
      if (live && live.length >= 4) {
        const points = live;
        setHistory((h) => [...h, { kind: 'stroke', stroke: { color, width: PEN_WIDTH, points } }]);
      }
      setLive(null);
    },
    onResponderTerminate: () => setLive(null),
  };

  const annotations = useMemo<Annotations>(() => {
    const strokes = history
      .filter((a): a is Extract<Action, { kind: 'stroke' }> => a.kind === 'stroke')
      .map((a) => a.stroke);
    const texts = history
      .filter((a): a is Extract<Action, { kind: 'text' }> => a.kind === 'text')
      .map((a) => a.text);
    const withLive =
      live && live.length >= 4 ? [...strokes, { color, width: PEN_WIDTH, points: live }] : strokes;
    return { strokes: withLive, texts };
  }, [history, live, color]);

  const undo = () => setHistory((h) => h.slice(0, -1));
  const clear = () => setHistory([]);

  const placeText = (e: { nativeEvent: { locationX: number; locationY: number } }) => {
    if (rect.w <= 0 || rect.h <= 0) return;
    setPending({
      x: Math.min(1, Math.max(0, e.nativeEvent.locationX / rect.w)),
      y: Math.min(1, Math.max(0, e.nativeEvent.locationY / rect.h)),
    });
    setDraft('');
  };

  const commitText = () => {
    const text = draft.trim();
    if (pending && text !== '') {
      const note: AnnotText = { x: pending.x, y: pending.y, color, size: TEXT_SIZE, text };
      setHistory((h) => [...h, { kind: 'text', text: note }]);
    }
    setPending(null);
    setDraft('');
  };

  const onBoxLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox({ w: width, h: height });
  };

  const save = () => onSave(isEmptyAnnotations(annotations) ? EMPTY_ANNOTATIONS : annotations);

  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {/* Top bar: cancel / mode label / save. */}
        <Row
          style={{
            justifyContent: 'space-between',
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.xxl,
            paddingBottom: theme.spacing.sm,
          }}
        >
          <IconButton label={t.common.cancel} onPress={onCancel}>
            <Ionicons name="close" size={iconSize.lg} color="#FFFFFF" />
          </IconButton>
          <Text variant="subheading" style={{ color: '#FFFFFF' }}>
            {t.annotate.title}
          </Text>
          <IconButton label={t.common.save} onPress={save}>
            {saving ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Ionicons name="checkmark" size={iconSize.lg} color="#FFFFFF" />
            )}
          </IconButton>
        </Row>

        {/* The canvas: the image, the overlay, and the input layer over its
            drawn rectangle. */}
        <View style={{ flex: 1 }} onLayout={onBoxLayout}>
          <ExpoImage source={{ uri }} style={{ flex: 1 }} contentFit="contain" transition={100} />
          <View
            style={{
              position: 'absolute',
              left: rect.x,
              top: rect.y,
              width: rect.w,
              height: rect.h,
            }}
          >
            <AnnotationOverlay annotations={annotations} width={rect.w} height={rect.h} />
            {mode === 'pen' ? (
              <View style={{ position: 'absolute', inset: 0 }} {...drawHandlers} />
            ) : (
              <Pressable
                style={{ position: 'absolute', inset: 0 }}
                onPress={placeText}
                accessibilityRole="button"
                accessibilityLabel={t.annotate.addText}
              />
            )}
          </View>
        </View>

        {/* Toolbar: pen/text, colour swatches, undo, clear. */}
        <Row
          style={{
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: theme.spacing.xl,
            paddingVertical: theme.spacing.md,
            gap: theme.spacing.md,
          }}
        >
          <Row style={{ gap: theme.spacing.sm }}>
            <ToolButton
              icon="pencil"
              active={mode === 'pen'}
              label={t.annotate.pen}
              onPress={() => setMode('pen')}
            />
            <ToolButton
              icon="text"
              active={mode === 'text'}
              label={t.annotate.addText}
              onPress={() => setMode('text')}
            />
          </Row>
          <Row style={{ gap: theme.spacing.sm, flex: 1, justifyContent: 'center' }}>
            {ANNOT_COLORS.map((c) => (
              <Pressable
                key={c}
                onPress={() => setColor(c)}
                accessibilityRole="button"
                accessibilityLabel={c}
                accessibilityState={{ selected: color === c }}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  backgroundColor: c,
                  borderWidth: color === c ? 3 : 1,
                  borderColor: color === c ? '#FFFFFF' : 'rgba(255,255,255,0.4)',
                }}
              />
            ))}
          </Row>
          <Row style={{ gap: theme.spacing.sm }}>
            <ToolButton icon="arrow-undo" label={t.annotate.undo} onPress={undo} />
            <ToolButton icon="trash-outline" label={t.annotate.clear} onPress={clear} />
          </Row>
        </Row>

        {/* Text entry for a dropped note. */}
        <Modal
          visible={pending !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setPending(null)}
        >
          <View
            style={{
              flex: 1,
              backgroundColor: 'rgba(0,0,0,0.6)',
              justifyContent: 'flex-end',
            }}
          >
            <View
              style={{
                padding: theme.spacing.xl,
                gap: theme.spacing.md,
                backgroundColor: theme.color.surface,
              }}
            >
              <TextInput
                value={draft}
                onChangeText={setDraft}
                autoFocus
                placeholder={t.annotate.textPlaceholder}
                placeholderTextColor={theme.color.textFaint}
                onSubmitEditing={commitText}
                style={{
                  minHeight: 44,
                  paddingHorizontal: theme.spacing.md,
                  borderRadius: theme.radius.md,
                  backgroundColor: theme.color.surfaceMuted,
                  color: theme.color.text,
                }}
              />
              <Row style={{ justifyContent: 'flex-end', gap: theme.spacing.md }}>
                <Pressable onPress={() => setPending(null)} accessibilityRole="button">
                  <Text tone="muted">{t.common.cancel}</Text>
                </Pressable>
                <Pressable onPress={commitText} accessibilityRole="button">
                  <Text style={{ color: theme.color.brand, fontWeight: '700' }}>
                    {t.common.done}
                  </Text>
                </Pressable>
              </Row>
            </View>
          </View>
        </Modal>
      </View>
    </Modal>
  );
}

function ToolButton({
  icon,
  label,
  active,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  active?: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: Boolean(active) }}
      style={{
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? 'rgba(255,255,255,0.22)' : 'transparent',
      }}
    >
      <Ionicons name={icon} size={iconSize.md} color="#FFFFFF" />
    </Pressable>
  );
}

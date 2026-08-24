/**
 * The receipt "adjust" editor (A46): rotate in 90° steps and crop, baking new
 * pixels. Unlike the pen/text overlay (data on the row), rotate and crop change
 * the image itself, so a save re-encodes and replaces the stored bytes — which
 * is also why it clears any markup (the old overlay no longer lines up).
 *
 * Rotation bakes immediately (each tap re-renders the working image and swaps
 * its dimensions); the crop is a normalised rectangle over the *displayed* image
 * rectangle, applied at save. One touch responder drives the crop: the grant
 * point is hit-tested against the four corner handles and the interior, so a
 * drag near a corner resizes and a drag inside moves — no per-handle views to
 * mis-measure. Everything is state (no refs) so the React Compiler is content.
 */

import { useEffect, useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image as ExpoImage } from 'expo-image';
import {
  ActivityIndicator,
  Image as RNImage,
  Modal,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import { IconButton, iconSize, Row, Text, useTheme } from '@waves/ui';

import { containRect } from '@/lib/annotations';
import { transformReceipt, type PickedImage } from '@/lib/image';
import { useStrings } from '@/i18n';

type Crop = { x: number; y: number; w: number; h: number };
const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 };
const MIN = 0.1; // Smallest crop, as a fraction — a sliver is never intended.
const HANDLE_HIT = 0.09; // How near a corner (fraction of the smaller edge) grabs it.

type DragMode = 'tl' | 'tr' | 'bl' | 'br' | 'move';

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function ReceiptCropper({
  uri,
  saving,
  onCancel,
  onSave,
}: {
  uri: string;
  saving: boolean;
  onCancel: () => void;
  onSave: (picked: PickedImage) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();

  const [workingUri, setWorkingUri] = useState(uri);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [crop, setCrop] = useState<Crop>(FULL);
  const [rotated, setRotated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<{
    mode: DragMode;
    startCrop: Crop;
    startX: number;
    startY: number;
  } | null>(null);

  const rect = useMemo(() => containRect(box, natural), [box, natural]);

  useEffect(() => {
    let active = true;
    RNImage.getSize(
      workingUri,
      (w, h) => active && setNatural({ w, h }),
      () => active && setNatural({ w: 1, h: 1 }),
    );
    return () => {
      active = false;
    };
  }, [workingUri]);

  const rotate = async (deg: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const out = await transformReceipt(workingUri, { rotate: deg });
      if (out) {
        setWorkingUri(out.uri);
        setNatural((n) => ({ w: n.h, h: n.w })); // 90° swaps the edges
        setCrop(FULL);
        setRotated(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const dirty = rotated || crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1;

  const save = async () => {
    if (busy || saving) return;
    setBusy(true);
    try {
      const isFull = crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1;
      const out = await transformReceipt(workingUri, {
        crop: isFull
          ? undefined
          : {
              originX: Math.round(crop.x * natural.w),
              originY: Math.round(crop.y * natural.h),
              width: Math.max(1, Math.round(crop.w * natural.w)),
              height: Math.max(1, Math.round(crop.h * natural.h)),
            },
      });
      if (out) onSave(out);
    } finally {
      setBusy(false);
    }
  };

  // One responder over the image rectangle: hit-test the grant against the
  // corners, then resize or move from the touch position.
  const norm = (v: number, span: number) => (span > 0 ? clamp01(v / span) : 0);
  const cropHandlers = {
    onStartShouldSetResponder: () => rect.w > 0 && rect.h > 0,
    onMoveShouldSetResponder: () => rect.w > 0 && rect.h > 0,
    onResponderGrant: (e: { nativeEvent: { locationX: number; locationY: number } }) => {
      const nx = norm(e.nativeEvent.locationX, rect.w);
      const ny = norm(e.nativeEvent.locationY, rect.h);
      const near = (a: number, b: number) => Math.abs(a - b) <= HANDLE_HIT;
      const nearX0 = near(nx, crop.x);
      const nearX1 = near(nx, crop.x + crop.w);
      const nearY0 = near(ny, crop.y);
      const nearY1 = near(ny, crop.y + crop.h);
      let mode: DragMode | null = null;
      if (nearX0 && nearY0) mode = 'tl';
      else if (nearX1 && nearY0) mode = 'tr';
      else if (nearX0 && nearY1) mode = 'bl';
      else if (nearX1 && nearY1) mode = 'br';
      else if (nx > crop.x && nx < crop.x + crop.w && ny > crop.y && ny < crop.y + crop.h)
        mode = 'move';
      if (mode) setDrag({ mode, startCrop: crop, startX: nx, startY: ny });
    },
    onResponderMove: (e: { nativeEvent: { locationX: number; locationY: number } }) => {
      if (!drag) return;
      const nx = norm(e.nativeEvent.locationX, rect.w);
      const ny = norm(e.nativeEvent.locationY, rect.h);
      const s = drag.startCrop;
      if (drag.mode === 'move') {
        const dx = nx - drag.startX;
        const dy = ny - drag.startY;
        setCrop({
          x: Math.min(Math.max(0, s.x + dx), 1 - s.w),
          y: Math.min(Math.max(0, s.y + dy), 1 - s.h),
          w: s.w,
          h: s.h,
        });
        return;
      }
      const right = s.x + s.w;
      const bottom = s.y + s.h;
      let { x, y, w, h } = s;
      if (drag.mode === 'tl') {
        x = Math.min(clamp01(nx), right - MIN);
        y = Math.min(clamp01(ny), bottom - MIN);
        w = right - x;
        h = bottom - y;
      } else if (drag.mode === 'tr') {
        y = Math.min(clamp01(ny), bottom - MIN);
        w = Math.max(MIN, clamp01(nx) - s.x);
        h = bottom - y;
      } else if (drag.mode === 'bl') {
        x = Math.min(clamp01(nx), right - MIN);
        w = right - x;
        h = Math.max(MIN, clamp01(ny) - s.y);
      } else {
        w = Math.max(MIN, clamp01(nx) - s.x);
        h = Math.max(MIN, clamp01(ny) - s.y);
      }
      setCrop({ x, y, w, h });
    },
    onResponderRelease: () => setDrag(null),
    onResponderTerminate: () => setDrag(null),
  };

  const onBoxLayout = (e: LayoutChangeEvent) =>
    setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });

  // Crop rectangle in display pixels, for the mask + handles.
  const cx = rect.x + crop.x * rect.w;
  const cy = rect.y + crop.y * rect.h;
  const cw = crop.w * rect.w;
  const ch = crop.h * rect.h;
  const mask = 'rgba(0,0,0,0.55)';
  const handle = (left: number, top: number) => (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: left - 10,
        top: top - 10,
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: '#FFFFFF',
        borderWidth: 2,
        borderColor: theme.color.brand,
      }}
    />
  );

  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
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
            {t.adjust.title}
          </Text>
          <IconButton label={t.common.save} onPress={save}>
            {saving || busy ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Ionicons
                name="checkmark"
                size={iconSize.lg}
                color={dirty ? '#FFFFFF' : 'rgba(255,255,255,0.35)'}
              />
            )}
          </IconButton>
        </Row>

        <View style={{ flex: 1 }} onLayout={onBoxLayout}>
          <ExpoImage source={{ uri: workingUri }} style={{ flex: 1 }} contentFit="contain" />
          {/* Dim everything outside the crop with four bands, and draw the
              handles. The responder sits over the whole image rectangle. */}
          {rect.w > 0 ? (
            <>
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: rect.x,
                  top: rect.y,
                  width: rect.w,
                  height: cy - rect.y,
                  backgroundColor: mask,
                }}
              />
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: rect.x,
                  top: cy + ch,
                  width: rect.w,
                  height: rect.y + rect.h - (cy + ch),
                  backgroundColor: mask,
                }}
              />
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: rect.x,
                  top: cy,
                  width: cx - rect.x,
                  height: ch,
                  backgroundColor: mask,
                }}
              />
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: cx + cw,
                  top: cy,
                  width: rect.x + rect.w - (cx + cw),
                  height: ch,
                  backgroundColor: mask,
                }}
              />
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: cx,
                  top: cy,
                  width: cw,
                  height: ch,
                  borderWidth: 1,
                  borderColor: '#FFFFFF',
                }}
              />
              {handle(cx, cy)}
              {handle(cx + cw, cy)}
              {handle(cx, cy + ch)}
              {handle(cx + cw, cy + ch)}
              <View
                style={{
                  position: 'absolute',
                  left: rect.x,
                  top: rect.y,
                  width: rect.w,
                  height: rect.h,
                }}
                {...cropHandlers}
              />
            </>
          ) : null}
        </View>

        <Row
          style={{
            justifyContent: 'center',
            gap: theme.spacing.xl,
            paddingVertical: theme.spacing.lg,
          }}
        >
          <IconButton label={t.adjust.rotateLeft} onPress={() => void rotate(-90)}>
            <Ionicons name="return-up-back" size={iconSize.lg} color="#FFFFFF" />
          </IconButton>
          <IconButton label={t.adjust.rotateRight} onPress={() => void rotate(90)}>
            <Ionicons name="return-up-forward" size={iconSize.lg} color="#FFFFFF" />
          </IconButton>
          <IconButton label={t.adjust.reset} onPress={() => setCrop(FULL)}>
            <Ionicons name="scan-outline" size={iconSize.lg} color="#FFFFFF" />
          </IconButton>
        </Row>
      </View>
    </Modal>
  );
}

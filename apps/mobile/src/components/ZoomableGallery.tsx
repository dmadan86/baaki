import { useRef, useState } from 'react';
import { FlatList, useWindowDimensions, View, type ListRenderItemInfo } from 'react-native';

import { ZoomableImage } from '@/components/ZoomableImage';
import type { Annotations } from '@/lib/annotations';

/** One gallery page: its resolved URL (null while resolving) and any markup. */
export interface GalleryPage {
  url: string | null;
  annotations?: Annotations;
}

/**
 * A full-screen, swipeable gallery: one {@link ZoomableImage} per page, paged
 * horizontally. Swiping between pages and pinch-zoom on a page share the same
 * screen, so the two must not fight — while any page is zoomed past fit the
 * pager stops scrolling, and panning moves the enlarged image instead. Back at
 * fit, the swipe returns.
 *
 * The URLs are resolved by the caller (each backend signs its own), so this only
 * draws them; a still-resolving page shows nothing rather than a broken frame.
 */
export function ZoomableGallery({
  pages,
  index,
  onIndexChange,
}: {
  /** One page per image, in order. A page's null url is still resolving. */
  pages: readonly GalleryPage[];
  index: number;
  onIndexChange: (index: number) => void;
}): React.JSX.Element {
  const { width } = useWindowDimensions();
  const [zoomed, setZoomed] = useState(false);
  const listRef = useRef<FlatList<GalleryPage>>(null);

  const renderItem = ({ item }: ListRenderItemInfo<GalleryPage>) => (
    <View style={{ width, flex: 1, justifyContent: 'center' }}>
      {item.url ? (
        <ZoomableImage uri={item.url} onZoomChange={setZoomed} annotations={item.annotations} />
      ) : null}
    </View>
  );

  return (
    <FlatList
      ref={listRef}
      data={pages as GalleryPage[]}
      keyExtractor={(_, i) => String(i)}
      renderItem={renderItem}
      horizontal
      pagingEnabled
      // The one rule that keeps swipe and zoom from fighting: no page-to-page
      // scroll while a page is magnified.
      scrollEnabled={!zoomed}
      showsHorizontalScrollIndicator={false}
      initialScrollIndex={index}
      getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
      onMomentumScrollEnd={(event) => {
        const next = Math.round(event.nativeEvent.contentOffset.x / width);
        if (next !== index) onIndexChange(next);
      }}
    />
  );
}

/**
 * The group screen's overflow menu.
 *
 * The header used to line up a back button, the group's name, and then three
 * more circular buttons — planner, spending, settings — all competing for the
 * same row. On a narrow phone the name was the thing that gave way. So the
 * three collapse into one `•••`, which now opens a real menu rather than
 * jumping straight to settings: three dots that behave like three dots.
 *
 * Planner only appears where there is a trip to plan; a flatshare has no use
 * for it, and a menu row nobody taps is just another thing to read past.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Card, directionalIcon, IconButton, ListRow, Text, useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';

export function GroupMenu({ groupId, isTrip }: { groupId: string; isTrip: boolean }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useStrings();
  const [open, setOpen] = useState(false);

  const go = (path: string): void => {
    setOpen(false);
    router.push(path as never);
  };

  const chip = (name: keyof typeof Ionicons.glyphMap) => (
    <View
      style={{
        width: 40,
        height: 40,
        borderRadius: theme.radius.pill,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.color.surfaceMuted,
      }}
    >
      <Ionicons name={name} size={19} color={theme.color.brand} />
    </View>
  );

  const chevron = (
    <Ionicons name={directionalIcon('chevron-forward')} size={18} color={theme.color.textFaint} />
  );

  return (
    <>
      <IconButton label={t.group.more} onPress={() => setOpen(true)}>
        <Ionicons name="ellipsis-horizontal" size={20} color={theme.color.text} />
      </IconButton>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        {/* Backdrop: a tap anywhere off the sheet closes it. */}
        <Pressable
          accessibilityLabel={t.common.close}
          onPress={() => setOpen(false)}
          style={{ flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' }}
        >
          {/* Stop taps on the sheet itself from reaching the backdrop. */}
          <Pressable onPress={() => {}}>
            <Card
              style={{
                borderTopLeftRadius: theme.radius.xxl,
                borderTopRightRadius: theme.radius.xxl,
                borderBottomLeftRadius: 0,
                borderBottomRightRadius: 0,
                paddingBottom: insets.bottom + theme.spacing.md,
                gap: theme.spacing.xs,
              }}
            >
              <View
                style={{
                  alignSelf: 'center',
                  width: 40,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: theme.color.border,
                  marginBottom: theme.spacing.sm,
                }}
              />
              <ListRow
                title={t.spending}
                leading={chip('pie-chart-outline')}
                trailing={chevron}
                onPress={() => go(`/group/${groupId}/insights`)}
              />
              {isTrip ? (
                <ListRow
                  title={t.plan}
                  leading={chip('map-outline')}
                  trailing={chevron}
                  onPress={() => go(`/group/${groupId}/plan`)}
                />
              ) : null}
              <ListRow
                title={t.group.settings}
                leading={chip('settings-outline')}
                trailing={chevron}
                onPress={() => go(`/group/${groupId}/settings`)}
              />
            </Card>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

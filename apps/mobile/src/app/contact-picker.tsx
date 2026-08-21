/**
 * The full-screen contact picker.
 *
 * Adding people to a group used to open the address book inline — a tall list
 * folded into the middle of the new-group and members forms. A thousand-name
 * book needs the whole screen (the alphabet rail needs somewhere to aim), so it
 * lives here as its own route now, and the form that wanted it navigates in.
 *
 * A pushed route cannot return a value the way an inline callback did, so the
 * caller leaves its intent in `contactPickerBridge` first — who is already
 * picked, and what to do with the answer — and this screen reads it once on
 * open. Confirming hands the ticked people back through that callback and
 * closes; backing out without confirming drops the request untouched.
 */

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { View } from 'react-native';

import { directionalIcon, IconButton, iconSize, Row, Screen, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';

import { ContactPicker, type PickedContact } from '@/components/ContactPicker';
import { clearContactRequest, peekContactRequest } from '@/lib/contactPickerBridge';

export default function ContactPickerScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();

  // Read once on mount and hold it: the module request is cleared on the way
  // out, but this screen keeps its own copy so a re-render cannot lose the
  // caller's callback mid-session.
  const [request] = useState(() => peekContactRequest());

  // Opened with no pending request (a deep link, a stray navigation) has
  // nothing to pick for — close rather than show a picker that answers nobody.
  useEffect(() => {
    if (!request) router.back();
  }, [request]);

  const confirm = (people: readonly PickedContact[]): void => {
    request?.onPicked(people);
    clearContactRequest();
    router.back();
  };

  return (
    // The picker anchors its confirm button to the foot of the screen, so this
    // route holds the bottom inset too — otherwise the button hides under the
    // navigation bar on a three-button phone.
    <Screen edges={['top', 'bottom']}>
      <View
        style={{
          flex: 1,
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.md,
          gap: theme.spacing.lg,
        }}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.misc.fromYourContacts}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <ContactPicker
          onConfirm={confirm}
          initialSelected={request?.initial}
          existing={request?.existing}
          confirmVerb={t.add}
        />
      </View>
    </Screen>
  );
}

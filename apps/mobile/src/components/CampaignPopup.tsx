/**
 * The announcement, once.
 *
 * A campaign is the one thing in this app that interrupts somebody who came to
 * do something else, so it earns its place by being rare and easy to dismiss.
 * The server decides whether there is anything to show — `baaki_my_campaign()`
 * returns at most one row, already filtered by country, by date, by whether it
 * has been seen, and by the holdout. The app cannot tell whether it is in the
 * holdout or whether a campaign exists that it was not offered, and that is
 * deliberate: a control group that knows it is a control group is not one.
 *
 * The impression is recorded when it is shown rather than when it is dismissed.
 * A person who opens the app, sees this, and force-quits has still seen it, and
 * the funnel should say so.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal, Pressable, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { Button, Text, useTheme } from '@baaki/ui';

import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

interface Campaign {
  id: string;
  title: string;
  body: string;
  cta_label: string;
  promo_code: string | null;
  ends_at: string;
}

async function fetchCampaign(): Promise<Campaign | null> {
  const { data, error } = await supabase.rpc('baaki_my_campaign');
  // An announcement is never worth an error state on somebody's expense screen.
  if (error) return null;
  const rows = (data ?? []) as Campaign[];
  return rows[0] ?? null;
}

export function CampaignPopup() {
  const theme = useTheme();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data: campaign } = useQuery({
    queryKey: ['campaign'],
    queryFn: fetchCampaign,
    enabled: Boolean(session),
    // Checked once a session. A campaign that starts while somebody is mid-tap
    // can wait until the next launch.
    staleTime: Infinity,
    retry: 1,
  });

  const seen = useMutation({
    mutationFn: async ({ id, acted }: { id: string; acted: boolean }) => {
      await supabase.rpc('baaki_campaign_seen', { p_campaign_id: id, p_acted: acted });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['campaign'] }),
  });

  // On show, not on dismiss: somebody who reads this and force-quits has still
  // been reached, and the funnel would otherwise never know.
  useEffect(() => {
    if (campaign && !dismissed) seen.mutate({ id: campaign.id, acted: false });
    // Only when the campaign itself changes — re-running on every render of the
    // mutation object would report the same impression forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign?.id]);

  if (!campaign || dismissed) return null;

  const close = () => setDismissed(true);

  const act = async () => {
    if (campaign.promo_code) {
      await Clipboard.setStringAsync(campaign.promo_code);
      setCopied(true);
    }
    seen.mutate({ id: campaign.id, acted: true });
  };

  return (
    <Modal transparent animationType="fade" visible onRequestClose={close}>
      {/* Tapping outside closes it. An announcement that traps somebody is an
          advertisement, and this is not one. */}
      <Pressable
        onPress={close}
        accessibilityLabel="Dismiss"
        style={{
          flex: 1,
          backgroundColor: 'rgba(10, 10, 26, 0.55)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: theme.spacing.xxl,
        }}
      >
        {/* Swallows the tap so pressing the card itself does not dismiss it. */}
        <Pressable
          onPress={() => {}}
          style={{
            width: '100%',
            maxWidth: 380,
            backgroundColor: theme.color.surface,
            borderRadius: theme.radius.xl,
            padding: theme.spacing.xxl,
            gap: theme.spacing.md,
            ...theme.shadow.lifted,
          }}
        >
          <Text variant="title">{campaign.title}</Text>
          {campaign.body ? (
            <Text variant="body" tone="muted">
              {campaign.body}
            </Text>
          ) : null}

          {campaign.promo_code ? (
            <View
              style={{
                backgroundColor: theme.color.brandSoft,
                borderRadius: theme.radius.md,
                paddingVertical: theme.spacing.md,
                alignItems: 'center',
              }}
            >
              <Text variant="heading" tone="brand">
                {campaign.promo_code}
              </Text>
              <Text variant="micro" tone="muted">
                {copied ? 'Copied' : 'Tap the button to copy'}
              </Text>
            </View>
          ) : null}

          <View style={{ gap: theme.spacing.sm, paddingTop: theme.spacing.sm }}>
            <Button
              label={campaign.cta_label || 'Got it'}
              size="lg"
              fullWidth
              onPress={() => void act()}
            />
            <Button label="Not now" variant="secondary" size="sm" fullWidth onPress={close} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

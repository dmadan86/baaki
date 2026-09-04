/**
 * The announcement, once.
 *
 * A campaign is the one thing in this app that interrupts somebody who came to
 * do something else, so it earns its place by being rare and easy to dismiss.
 * The server decides whether there is anything to show — `waves_my_campaign()`
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
import { Pressable, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { Button, Popup, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { backend } from '@/lib/backend';
import { usePromptSlot } from '@/lib/promptQueue';

interface Campaign {
  id: string;
  title: string;
  body: string;
  cta_label: string;
  promo_code: string | null;
  ends_at: string;
}

async function fetchCampaign(): Promise<Campaign | null> {
  const { data, error } = await backend.rpc('waves_my_campaign');
  // An announcement is never worth an error state on somebody's expense screen.
  if (error) return null;
  const rows = (data ?? []) as Campaign[];
  return rows[0] ?? null;
}

export function CampaignPopup() {
  const theme = useTheme();
  const { t } = useStrings();
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
      await backend.rpc('waves_campaign_seen', { p_campaign_id: id, p_acted: acted });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['campaign'] }),
  });

  // Wait its turn behind the tour and the push ask rather than stacking on them:
  // the announcement claims a queue slot while there is one to show and only
  // renders when it is the live winner.
  const wants = Boolean(campaign) && !dismissed;
  const granted = usePromptSlot({ id: 'campaign', priority: 60, active: wants, delayMs: 300 });

  // On show, not on dismiss, and only once it is actually granted the screen:
  // somebody who reads this and force-quits has still been reached, but one that
  // never surfaced (a higher-priority prompt held the queue) has not.
  useEffect(() => {
    if (campaign && !dismissed && granted) seen.mutate({ id: campaign.id, acted: false });
    // Only when the campaign changes or it is first granted — re-running on every
    // render of the mutation object would report the same impression forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign?.id, granted]);

  if (!campaign || dismissed || !granted) return null;

  const close = () => setDismissed(true);

  const act = async () => {
    if (campaign.promo_code) {
      await Clipboard.setStringAsync(campaign.promo_code);
      setCopied(true);
    }
    seen.mutate({ id: campaign.id, acted: true });
    close();
  };

  return (
    <Popup visible onClose={close} closeLabel={t.common.close} style={{ gap: theme.spacing.md }}>
      <Text variant="title">{campaign.title}</Text>
      {campaign.body ? (
        <Text variant="body" tone="muted">
          {campaign.body}
        </Text>
      ) : null}

      {campaign.promo_code ? (
        <Pressable
          onPress={() => void act()}
          accessibilityRole="button"
          accessibilityLabel={t.misc.tapToCopy}
          style={{
            backgroundColor: theme.color.buttonPrimary,
            borderRadius: theme.radius.md,
            paddingVertical: theme.spacing.md,
            alignItems: 'center',
          }}
        >
          <Text variant="heading" tone="onBrand">
            {campaign.promo_code}
          </Text>
          <Text variant="micro" tone="onBrand">
            {copied ? t.misc.copied : t.misc.tapToCopy}
          </Text>
        </Pressable>
      ) : null}

      <View style={{ gap: theme.spacing.sm, paddingTop: theme.spacing.sm }}>
        <Button
          label={campaign.cta_label || t.misc.gotIt}
          size="lg"
          fullWidth
          onPress={() => void act()}
        />
        <Button label={t.misc.notNow} variant="secondary" size="sm" fullWidth onPress={close} />
      </View>
    </Popup>
  );
}

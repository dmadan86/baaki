/**
 * A campaign, rendered as an email (TDR §7, §7.3 — the broadcast half of A21).
 *
 * The in-app campaign shows the targeted cohort an announcement once. This turns
 * the same announcement — title, body, a button, and the promo code it is about
 * — into a marketing email for the people who have not opened the app since it
 * started. It is the same shape as `email.ts` and for the same reason: the send
 * is a `fetch` in an edge function, and everything that can be got wrong lives
 * here, where a test can read it without a mailbox.
 *
 * Two things a campaign mail must carry that a notification mail already does:
 *
 *   * **One-click unsubscribe.** A promotion is bulk mail by definition, so
 *     `List-Unsubscribe` and its one-click partner are not optional — Gmail and
 *     Yahoo drop bulk senders without them into spam. The URL is signed over the
 *     address (see `signUnsubscribe`) because RFC 8058 has the mailbox POST it
 *     unattended, with no session to prove who is asking.
 *   * **An honest reason for arriving.** A campaign has no group to point at, so
 *     the footer says the true thing instead: you use Baaki. `copy.email.why`
 *     would name a group that does not exist; `promoReason` is its campaign
 *     counterpart.
 *
 * What it does NOT do is decide who gets it. The audience, the holdout and the
 * suppression check are all in SQL (`baaki_claim_campaign_emails`), because a
 * holdout accidentally mailed is a control group destroyed, and that decision is
 * too important to sit in a renderer.
 */

import { copyFor } from './copy';
import { escapeHtml } from './email';

export interface CampaignEmailInput {
  /**
   * The `campaign_email_sends` row id. Doubles as the send's idempotency key, so
   * a run that times out after Resend accepted does not send a second copy when
   * it is retried.
   */
  readonly sendId: string;
  readonly title: string;
  readonly body: string;
  /** The button's words. Blank means no call to action beyond reading it. */
  readonly ctaLabel: string;
  /** The code the announcement is about, shown to type by hand. NULL is fine. */
  readonly promoCode?: string | null;
  readonly locale?: string | null;
  /** The recipient's address, already checked against the suppression list. */
  readonly to: string;
}

export interface CampaignEmailOptions {
  /**
   * Where the button lands. Web-lite has no redeem page, so with a web URL the
   * button opens web-lite and the code is typed in the app; with none it falls
   * back to a `waves://redeem` deep link, which works on the phone and does
   * nothing in desktop webmail — where the visible code chip is the way in.
   */
  readonly webUrl?: string | null;
  /** Signed, address-specific, and safe to POST without a session. */
  readonly unsubscribeUrl: string;
}

export interface BuiltCampaignEmail {
  readonly sendId: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** `List-Unsubscribe` and its one-click partner — mandatory on bulk mail. */
  readonly headers: Readonly<Record<string, string>>;
}

/** Languages written right to left. Only the layout changes; the copy is copy. */
const RIGHT_TO_LEFT = new Set(['ar', 'he', 'fa', 'ur']);

/**
 * The button's target.
 *
 * A configured web URL wins. Failing that, a promo code becomes a `waves://`
 * deep link so a phone can open straight into redeeming it. With neither there
 * is nothing to link to, and the mail is still worth sending for what it says.
 */
export function campaignCtaUrl(
  promoCode: string | null | undefined,
  webUrl?: string | null,
): string | null {
  if (webUrl && /^https?:\/\//i.test(webUrl.trim())) return webUrl.trim().replace(/\/+$/, '');
  if (promoCode) return `waves://redeem?code=${encodeURIComponent(promoCode)}`;
  return null;
}

export function renderCampaignEmail(
  input: CampaignEmailInput,
  options: CampaignEmailOptions,
): BuiltCampaignEmail {
  const locale = input.locale ?? 'en';
  const language = locale.slice(0, 2).toLowerCase();
  const copy = copyFor(locale);
  const direction = RIGHT_TO_LEFT.has(language) ? 'rtl' : 'ltr';

  const link = input.ctaLabel.trim() ? campaignCtaUrl(input.promoCode, options.webUrl) : null;
  const code = input.promoCode?.trim() || null;

  // An operator-edited title must not smuggle a line break into a mail header,
  // and an empty subject raises the spam score. Normalise it here, where a test
  // can read the value, rather than in the send path.
  const subject = input.title.replace(/[\r\n]+/g, ' ').trim();

  return {
    sendId: input.sendId,
    to: input.to,
    subject,
    html: renderHtml({
      direction,
      language,
      title: input.title,
      body: input.body,
      action: input.ctaLabel.trim(),
      link,
      code,
      why: copy.email.promoReason,
      unsubscribe: copy.email.unsubscribe,
      unsubscribeUrl: options.unsubscribeUrl,
      signature: copy.email.signature,
    }),
    text: [
      input.title,
      '',
      input.body,
      '',
      code ?? '',
      link ?? '',
      '',
      copy.email.promoReason,
      `${copy.email.unsubscribe}: ${options.unsubscribeUrl}`,
    ]
      .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
      .join('\n')
      .trim(),
    headers: {
      'List-Unsubscribe': `<${options.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

interface HtmlParts {
  readonly direction: 'ltr' | 'rtl';
  readonly language: string;
  readonly title: string;
  readonly body: string;
  readonly action: string;
  readonly link: string | null;
  readonly code: string | null;
  readonly why: string;
  readonly unsubscribe: string;
  readonly unsubscribeUrl: string;
  readonly signature: string;
}

/**
 * The same plain, inline-styled, image-free card the notification mail uses. No
 * remote images: a tracking pixel is what makes a client hide the whole message
 * behind "load images", and Resend's own open-tracking already reports opens.
 */
function renderHtml(parts: HtmlParts): string {
  const align = parts.direction === 'rtl' ? 'right' : 'left';
  const codeChip = parts.code
    ? `<p style="margin:0 0 20px;"><span style="display:inline-block;padding:8px 14px;border-radius:8px;background:#f5f5f4;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;letter-spacing:1px;color:#1c1917;">${escapeHtml(parts.code)}</span></p>`
    : '';
  const button =
    parts.link && parts.action
      ? `<a href="${escapeHtml(parts.link)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#1c1917;color:#ffffff;text-decoration:none;font-size:15px;">${escapeHtml(parts.action)}</a>`
      : '';
  return `<!doctype html>
<html lang="${escapeHtml(parts.language)}" dir="${parts.direction}">
<body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;text-align:${align};">
<h1 style="margin:0 0 12px;font-size:20px;line-height:1.35;color:#1c1917;">${escapeHtml(parts.title)}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#44403c;">${escapeHtml(parts.body)}</p>
${codeChip}${button}
<p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#78716c;">${escapeHtml(parts.why)}<br />
<a href="${escapeHtml(parts.unsubscribeUrl)}" style="color:#78716c;">${escapeHtml(parts.unsubscribe)}</a></p>
</div>
<p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#a8a29e;text-align:${align};">${escapeHtml(parts.signature)}</p>
</body>
</html>`;
}

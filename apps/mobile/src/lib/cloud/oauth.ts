/**
 * The one OAuth dance, shared by all three providers.
 *
 * Drive, Dropbox and OneDrive are all authorization-code + PKCE providers that
 * differ only in their endpoints, scopes and a couple of extra query params to
 * coax out a refresh token. So the flow lives here once — build a PKCE request,
 * open the system browser, swap the returned code for tokens — and each provider
 * supplies its discovery document and scopes.
 *
 * PKCE means no client secret is embedded in the app (there is nowhere safe to
 * put one on a phone). The redirect comes back to the app's own `baaki://`
 * scheme, the same mechanism the Supabase sign-in already uses.
 */

import {
  AuthRequest,
  exchangeCodeAsync,
  makeRedirectUri,
  refreshAsync,
  type AuthDiscoveryDocument,
  type TokenResponse,
} from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

import type { CloudTokens } from './types';

// Lets the auth popup hand its result back and close itself when the app is
// re-focused after the redirect. A no-op on native, required on web.
WebBrowser.maybeCompleteAuthSession();

/** The endpoints for one provider. `revocationEndpoint` is optional. */
export interface OAuthEndpoints extends AuthDiscoveryDocument {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

export interface OAuthConfig {
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly discovery: OAuthEndpoints;
  /** Provider-specific query params, e.g. Google's `access_type=offline`. */
  readonly extraParams?: Record<string, string>;
}

/** All providers redirect back here — one path, distinct from `auth` sign-in. */
function redirectUri(): string {
  return makeRedirectUri({ scheme: 'baaki', path: 'oauthredirect' });
}

function toTokens(response: TokenResponse, previousRefresh?: string | null): CloudTokens {
  return {
    accessToken: response.accessToken,
    // A refresh returns a new refresh token only sometimes; keep the old one
    // when it doesn't, or the next refresh has nothing to present.
    refreshToken: response.refreshToken ?? previousRefresh ?? null,
    expiresAt: response.expiresIn ? Date.now() + response.expiresIn * 1000 : null,
  };
}

/**
 * Run the interactive flow. Resolves to tokens, or null if the person closed
 * the browser without granting — a cancel, not an error.
 */
export async function authorize(config: OAuthConfig): Promise<CloudTokens | null> {
  const request = new AuthRequest({
    clientId: config.clientId,
    scopes: [...config.scopes],
    redirectUri: redirectUri(),
    usePKCE: true,
    extraParams: config.extraParams,
  });

  const result = await request.promptAsync(config.discovery);
  if (result.type !== 'success' || !result.params.code) return null;

  const token = await exchangeCodeAsync(
    {
      clientId: config.clientId,
      code: result.params.code,
      redirectUri: redirectUri(),
      // PKCE proof: the verifier behind the challenge sent in the auth request.
      extraParams: { code_verifier: request.codeVerifier ?? '' },
    },
    config.discovery,
  );

  return toTokens(token);
}

/**
 * Trade a refresh token for a fresh access token. Returns the input unchanged
 * when there is no refresh token to use — the caller then re-authorises.
 */
export async function refresh(config: OAuthConfig, tokens: CloudTokens): Promise<CloudTokens> {
  if (!tokens.refreshToken) return tokens;
  const token = await refreshAsync(
    { clientId: config.clientId, refreshToken: tokens.refreshToken, extraParams: config.extraParams },
    config.discovery,
  );
  return toTokens(token, tokens.refreshToken);
}

/** A minute's grace, so a token that expires mid-upload is refreshed first. */
const EXPIRY_SKEW_MS = 60_000;

/** True when the access token is missing or about to expire. */
export function isExpired(tokens: CloudTokens): boolean {
  return tokens.expiresAt !== null && tokens.expiresAt - EXPIRY_SKEW_MS <= Date.now();
}

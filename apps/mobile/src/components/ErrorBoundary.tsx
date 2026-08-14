/**
 * The last line before a white screen.
 *
 * React has one rule about a component that throws while rendering: the whole
 * tree below the nearest error boundary is unmounted. With no boundary that
 * nearest point is the root, so a single bad render — a malformed number, an
 * unexpected shape from the network, a library that throws on an edge case —
 * takes the entire app down to a blank screen with no way back. `Sentry.wrap`
 * adds tracing and a native crash handler, but not a React error boundary, so
 * this is the one that keeps a rendering bug from ending the session.
 *
 * In development the red box still shows first — this does not swallow anything
 * a developer needs to see. In production it catches, reports the error through
 * the same scrubbed pipeline as every other event, and offers the one action
 * that reliably recovers: drop back to a known-good screen and re-mount.
 */

import { Component, type ReactNode } from 'react';
import { router } from 'expo-router';
import { View } from 'react-native';

import { Button, Screen, Text, useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';
import { reportHandled } from '@/lib/observability';

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    // Reported, not hidden: the point of catching is to keep the app usable,
    // not to lose the bug. `reportHandled` is a no-op with no Sentry DSN set.
    reportHandled(error, 'render');
  }

  private reset = (): void => {
    this.setState({ hasError: false });
    // Home is the one route that always exists and needs nothing from the tree
    // that just failed, so re-mounting there cannot land back on the bad screen.
    router.replace('/');
  };

  render(): ReactNode {
    if (this.state.hasError) return <Fallback onReset={this.reset} />;
    return this.props.children;
  }
}

/** The recover screen. A function so it can read theme and strings via hooks. */
function Fallback({ onReset }: { onReset: () => void }) {
  const theme = useTheme();
  const { t } = useStrings();

  return (
    <Screen>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: theme.spacing.xxxl,
          gap: theme.spacing.lg,
        }}
      >
        <Text variant="display" align="center">
          {t.errorBoundary.title}
        </Text>
        <Text variant="body" tone="muted" align="center">
          {t.errorBoundary.body}
        </Text>
        <View style={{ paddingTop: theme.spacing.md, alignSelf: 'stretch' }}>
          <Button label={t.errorBoundary.action} size="lg" fullWidth onPress={onReset} />
        </View>
      </View>
    </Screen>
  );
}

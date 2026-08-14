'use client';

/**
 * Adding an expense, or editing one when `?expense=<id>` is present.
 *
 * The form itself — the split methods, the live preview, the write — lives in
 * ExpenseForm; this route only decides which group and whether an existing
 * expense is being edited. `useSearchParams` is wrapped in Suspense so a build
 * that tries to prerender the route has a boundary to fall back to.
 */

import { Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';

import { AppFrame } from '@/components/AppFrame';
import { Section } from '@/components/Shell';
import { ExpenseForm } from '@/components/ExpenseForm';

export default function AddExpensePage() {
  return (
    <AppFrame current={Section.Groups}>
      {({ profileId }) => (
        <Suspense fallback={null}>
          <AddOrEdit profileId={profileId} />
        </Suspense>
      )}
    </AppFrame>
  );
}

function AddOrEdit({ profileId }: { profileId: string }) {
  const params = useParams<{ groupId: string }>();
  const search = useSearchParams();
  return (
    <ExpenseForm
      groupId={params.groupId}
      myProfileId={profileId}
      expenseId={search.get('expense')}
    />
  );
}

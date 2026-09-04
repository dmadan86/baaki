import Link from 'next/link';

import { Aurora } from '@/components/aurora';
import { Wordmark } from '@/components/logo';
import { Button, Container } from '@/components/ui';

export default function NotFound() {
  return (
    <>
      <Aurora />
      <main className="flex min-h-screen items-center">
        <Container className="text-center">
          <Link href="/en" className="inline-flex">
            <Wordmark />
          </Link>
          <p className="mt-12 text-7xl font-semibold tracking-[-0.05em] text-white/15">404</p>
          <h1 className="mt-4 text-3xl font-semibold tracking-[-0.03em] text-white">
            This page settled up and left.
          </h1>
          <p className="mx-auto mt-4 max-w-md text-white/50">
            The link is broken or the page has moved. The ledger is fine.
          </p>
          <div className="mt-9 flex justify-center">
            <Button href="/en">Back to home</Button>
          </div>
        </Container>
      </main>
    </>
  );
}

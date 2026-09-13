"use client";

import { buttonClassName } from "@/features/workspace/primitives";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section className="mx-auto flex max-w-lg flex-col items-center gap-5 py-20 text-center [&>p]:text-sm [&>p]:leading-6 [&>p]:text-neutral-400">
      <h1>We couldn’t open this view.</h1>
      <p>Your saved watches keep running independently of this page.</p>
      <button className={buttonClassName("primary")} onClick={reset}>
        Try again
      </button>
    </section>
  );
}

import Link from "next/link";

import { buttonClassName } from "@/features/workspace/primitives";

export default function NotFound() {
  return (
    <section className="mx-auto flex max-w-lg flex-col items-center gap-5 py-20 text-center [&>p]:text-sm [&>p]:leading-6 [&>p]:text-neutral-400">
      <h1>Nothing at this address.</h1>
      <p>This page may have moved, or the link may be incomplete.</p>
      <Link className={buttonClassName("primary")} href="/">
        Back to Watches
      </Link>
    </section>
  );
}

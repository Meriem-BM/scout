import { redirect } from "next/navigation";
import { Suspense } from "react";

import { WatchEditor } from "@/features/watches/editor";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const { edit } = await searchParams;

  if (!edit) {
    redirect("/watches");
  }

  return (
    <Suspense fallback={<p>Opening your draft…</p>}>
      <WatchEditor />
    </Suspense>
  );
}

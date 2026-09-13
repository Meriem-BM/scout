import { Suspense } from "react";

import { WatchDetail } from "@/features/watches/detail";

export default async function Page({
  params,
}: {
  params: Promise<{ watchId: string; incidentId?: string }>;
}) {
  const p = await params;

  return (
    <Suspense>
      <WatchDetail id={p.watchId} incidentId={p.incidentId} />
    </Suspense>
  );
}

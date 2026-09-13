import { Suspense } from "react";

import { Connections } from "@/features/connections/connections";

export default function Page() {
  return (
    <Suspense>
      <Connections />
    </Suspense>
  );
}

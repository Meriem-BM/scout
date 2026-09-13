import { Suspense } from "react";

import { Watches } from "@/features/watches/watches";

export default function Page() {
  return (
    <Suspense>
      <Watches />
    </Suspense>
  );
}

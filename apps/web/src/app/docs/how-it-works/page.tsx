import { DocsPage } from "@/features/communication/docs";

export const metadata = {
  title: "How Scout works",
  robots: { index: true, follow: true },
};

export default function Page() {
  return <DocsPage page="works" />;
}

import { ProofView } from "@/features/watches/proof";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <ProofView id={id} />;
}

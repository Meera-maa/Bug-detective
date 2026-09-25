import { InvestigationView } from "@/components/InvestigationView";

export const metadata = { title: "Investigation · Bug Detective" };

export default async function InvestigationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvestigationView id={id} />;
}

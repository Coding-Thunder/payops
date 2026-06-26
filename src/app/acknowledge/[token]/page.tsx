import { notFound } from "next/navigation";

import { getPublicAcknowledgementView } from "@/server/services/acknowledgement.service";
import { AppError } from "@/lib/errors";

import { AcknowledgeForm } from "./acknowledge-form";

export const dynamic = "force-dynamic";

interface AcknowledgePageProps {
  params: Promise<{ token: string }>;
}

/**
 * Public hosted Terms & Conditions acknowledgement page. The customer arrives
 * from the "I Agree" button in the confirmation email. Renders the T&C and a
 * single button that records their acknowledgement (timestamp + IP).
 */
export default async function AcknowledgePage({
  params,
}: AcknowledgePageProps) {
  const { token } = await params;

  let view;
  try {
    view = await getPublicAcknowledgementView(token);
  } catch (err) {
    if (
      err instanceof AppError &&
      (err.statusCode === 400 || err.statusCode === 404)
    ) {
      notFound();
    }
    throw err;
  }

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-10">
      <AcknowledgeForm token={token} initialView={view} />
    </main>
  );
}

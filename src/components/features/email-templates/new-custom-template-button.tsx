import Link from "next/link";
import { PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

interface NewCustomTemplateButtonProps {
  variant?: "default" | "outline";
}

/**
 * + Create Template.
 *
 * This used to open a dialog that asked for a display name, a "Template
 * key" (lower-case kebab, 2–48 chars, must start with a letter), and a
 * description — three fields of setup standing between the operator and
 * writing a single word of the email. The key is an internal identifier;
 * the server derives it from the name now.
 *
 * So this is a link. It goes straight to the editor, where the operator
 * writes the email and saves once.
 */
export function NewCustomTemplateButton({
  variant = "default",
}: NewCustomTemplateButtonProps) {
  return (
    <Button asChild variant={variant} size="sm" className="gap-1.5">
      <Link href="/app/admin/email-templates/new">
        <PlusIcon className="size-3.5" />
        Create template
      </Link>
    </Button>
  );
}

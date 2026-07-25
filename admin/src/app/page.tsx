import { redirect } from "next/navigation";

import { getAdminEmail } from "@/server/auth/session";
import { LoginForm } from "@/components/login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Already signed in → straight to the dashboard.
  if (await getAdminEmail()) redirect("/dashboard");
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <LoginForm />
    </main>
  );
}

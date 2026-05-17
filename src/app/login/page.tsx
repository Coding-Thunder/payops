import { redirect } from "next/navigation";

import { env } from "@/lib/env";
import { getCurrentUser } from "@/server/auth/session";

import { LoginForm } from "./_components/login-form";

export const dynamic = "force-dynamic";

interface LoginPageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");
  const { next } = await searchParams;
  const brand = env.server.APP_NAME;

  return (
    <div className="grid min-h-screen w-full grid-cols-1 lg:grid-cols-2">
      <section className="hidden lg:flex flex-col justify-between bg-primary text-primary-foreground p-12">
        <div>
          <div className="text-xs tracking-[0.2em] uppercase opacity-80">
            {brand}
          </div>
          <div className="mt-2 text-base font-medium">
            Payment operations console
          </div>
        </div>
        <div className="space-y-6 max-w-md">
          <h2 className="text-3xl font-semibold tracking-tight leading-tight">
            Reliable, auditable
            <br />
            rental payments.
          </h2>
          <p className="text-sm leading-relaxed opacity-80">
            Create payable orders, share secure Stripe checkout links with
            customers, and stay in sync with every payment - all from one
            console designed for operations teams.
          </p>
        </div>
        <div className="text-xs opacity-70">
          Authorized access only • Activity is recorded
        </div>
      </section>

      <section className="flex items-center justify-center p-6 sm:p-12 bg-background">
        <div className="w-full max-w-sm space-y-8">
          <div className="space-y-2 text-center sm:text-left">
            <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
              {brand}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Sign in to your account
            </h1>
            <p className="text-sm text-muted-foreground">
              Use the credentials your administrator gave you.
            </p>
          </div>
          <LoginForm nextPath={next} />
          <p className="text-[11px] text-muted-foreground text-center">
            Trouble signing in? Reach out to your administrator. Public sign-ups
            are disabled.
          </p>
        </div>
      </section>
    </div>
  );
}

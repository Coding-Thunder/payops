"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  CircleIcon,
  CreditCardIcon,
  ExternalLinkIcon,
  PackageIcon,
  SparklesIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingButton } from "@/components/ui/loading-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import { CURRENCIES, type Currency } from "@/lib/constants/enums";

/**
 * Setup wizard, 6 sequential steps. Each step is self-contained;
 * the shell handles step navigation + progress indicator.
 *
 * State design: every step's inputs are derived from server-fetched
 * data passed in as `initial*` props. The wizard owns the "current
 * step" cursor + a mirror of each step's last-saved values. Saves go
 * directly to the underlying admin endpoints (org rename, settings,
 * branding), same endpoints the dedicated admin pages use. The
 * wizard is pure UI orchestration over those primitives.
 *
 * Skipping: each step can be skipped via "Skip for now", moves the
 * cursor forward without saving. The dashboard checklist will still
 * nag for incomplete steps after the wizard closes.
 */

interface OrganizationProp {
  id: string;
  slug: string;
  name: string;
}

interface SettingsProp {
  defaultCurrency: Currency;
  orderPrefix: string;
}

interface BrandingProp {
  brandName: string;
  primaryColor: string;
}

interface OnboardingStepsProp {
  gatewayConfigured: boolean;
  businessSetupDone: boolean;
  brandingSet: boolean;
  firstOrderCreated: boolean;
  teamMemberAdded: boolean;
}

interface WizardProps {
  initialStep: number;
  organization: OrganizationProp;
  settings: SettingsProp;
  branding: BrandingProp;
  onboardingSteps: OnboardingStepsProp;
}

const STEPS = [
  { id: 1, title: "Company", description: "Name your workspace" },
  { id: 2, title: "Basics", description: "Currency + order prefix" },
  { id: 3, title: "Branding", description: "How customers see you" },
  { id: 4, title: "Payments", description: "Connect Stripe" },
  { id: 5, title: "Catalog", description: "First product or service" },
  { id: 6, title: "Done", description: "Start taking payments" },
] as const;

const TOTAL_STEPS = STEPS.length;

export function SetupWizard({
  initialStep,
  organization,
  settings,
  branding,
  onboardingSteps,
}: WizardProps) {
  const router = useRouter();
  const clamped = Math.min(Math.max(1, initialStep), TOTAL_STEPS);
  const [step, setStep] = useState<number>(clamped);

  function goTo(next: number) {
    const clamped = Math.min(Math.max(1, next), TOTAL_STEPS);
    setStep(clamped);
    // Update URL so refresh + share preserves the cursor.
    const url = new URL(window.location.href);
    url.searchParams.set("step", String(clamped));
    window.history.replaceState({}, "", url.toString());
  }

  function finish() {
    router.push("/app/dashboard");
  }

  return (
    <div className="space-y-8">
      <Header step={step} />

      <Card>
        <CardContent className="pt-6">
          {step === 1 ? (
            <CompanyStep
              organization={organization}
              onNext={() => goTo(2)}
              onSkip={() => goTo(2)}
            />
          ) : null}
          {step === 2 ? (
            <BasicsStep
              settings={settings}
              onNext={() => goTo(3)}
              onBack={() => goTo(1)}
              onSkip={() => goTo(3)}
            />
          ) : null}
          {step === 3 ? (
            <BrandingStep
              branding={branding}
              onNext={() => goTo(4)}
              onBack={() => goTo(2)}
              onSkip={() => goTo(4)}
            />
          ) : null}
          {step === 4 ? (
            <StripeStep
              configured={onboardingSteps.gatewayConfigured}
              onNext={() => goTo(5)}
              onBack={() => goTo(3)}
              onSkip={() => goTo(5)}
            />
          ) : null}
          {step === 5 ? (
            <CatalogStep
              done={onboardingSteps.businessSetupDone}
              onNext={() => goTo(6)}
              onBack={() => goTo(4)}
              onSkip={() => goTo(6)}
            />
          ) : null}
          {step === 6 ? (
            <DoneStep
              onboardingSteps={onboardingSteps}
              onFinish={finish}
              onBack={() => goTo(5)}
            />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

/* ───────────────────────────── Shell ──────────────────────────────────── */

function Header({ step }: { step: number }) {
  const meta = STEPS[step - 1]!;
  return (
    <header className="space-y-4">
      <div>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
          Step {step} of {TOTAL_STEPS} · {meta.title}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {meta.description}
        </h1>
      </div>
      <Progress current={step} />
    </header>
  );
}

function Progress({ current }: { current: number }) {
  return (
    <ol className="flex gap-1.5">
      {STEPS.map((s) => (
        <li
          key={s.id}
          aria-current={s.id === current ? "step" : undefined}
          className="flex-1"
        >
          <span
            className={`block h-1 rounded-full transition-colors ${
              s.id < current
                ? "bg-primary"
                : s.id === current
                  ? "bg-primary"
                  : "bg-border"
            }`}
          />
        </li>
      ))}
    </ol>
  );
}

function StepFooter({
  onBack,
  onSkip,
  primary,
}: {
  onBack?: () => void;
  onSkip?: () => void;
  primary: React.ReactNode;
}) {
  return (
    <div className="mt-8 flex items-center justify-between border-t pt-5">
      <div className="flex gap-2">
        {onBack ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="gap-1.5"
          >
            <ArrowLeftIcon className="size-3.5" /> Back
          </Button>
        ) : null}
        {onSkip ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onSkip}
          >
            Skip for now
          </Button>
        ) : null}
      </div>
      <div>{primary}</div>
    </div>
  );
}

/* ───────────────────────────── Step 1: Company ──────────────────────────── */

function CompanyStep({
  organization,
  onNext,
  onSkip,
}: {
  organization: OrganizationProp;
  onNext: () => void;
  onSkip: () => void;
}) {
  const [name, setName] = useState(organization.name);
  const [busy, setBusy] = useState(false);
  const dirty = name.trim() !== organization.name;

  async function save() {
    setBusy(true);
    try {
      await api.patch("/api/admin/organization", { name: name.trim() });
      toast.success("Workspace renamed");
      onNext();
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "Could not save",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-[13.5px] text-muted-foreground">
        Your workspace name appears in customer-facing emails and on the
        admin console. Change it from the auto-generated default to your
        actual business name.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="org-name">Workspace name</Label>
        <Input
          id="org-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          placeholder="Acme Coffee Roasters"
          disabled={busy}
        />
        <p className="text-[11.5px] text-muted-foreground">
          URL slug stays{" "}
          <code className="font-mono">{organization.slug}</code>, renaming
          the slug would break shared URLs.
        </p>
      </div>
      <StepFooter
        onSkip={onSkip}
        primary={
          <LoadingButton
            onClick={dirty ? save : onNext}
            loading={busy}
            loadingText="Saving"
            className="gap-1.5"
          >
            {dirty ? "Save and continue" : "Continue"}
            <ArrowRightIcon className="size-3.5" />
          </LoadingButton>
        }
      />
    </div>
  );
}

/* ───────────────────────────── Step 2: Basics ───────────────────────────── */

function BasicsStep({
  settings,
  onNext,
  onBack,
  onSkip,
}: {
  settings: SettingsProp;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  const [currency, setCurrency] = useState<Currency>(settings.defaultCurrency);
  const [prefix, setPrefix] = useState(settings.orderPrefix);
  const [busy, setBusy] = useState(false);
  const dirty =
    currency !== settings.defaultCurrency || prefix !== settings.orderPrefix;

  async function save() {
    setBusy(true);
    try {
      await api.patch("/api/admin/settings", {
        defaultCurrency: currency,
        orderPrefix: prefix,
      });
      toast.success("Saved");
      onNext();
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "Could not save",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-[13.5px] text-muted-foreground">
        Pick the currency you charge in and a short prefix for your order
        numbers (e.g. ACME-260601-A3F8).
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="currency">Default currency</Label>
          <Select
            value={currency}
            onValueChange={(v) => setCurrency(v as Currency)}
            disabled={busy}
          >
            <SelectTrigger id="currency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="prefix">Order prefix</Label>
          <Input
            id="prefix"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value.toUpperCase())}
            maxLength={8}
            placeholder="ORD"
            disabled={busy}
            className="font-mono"
          />
          <p className="text-[11.5px] text-muted-foreground">
            Used as the first segment of every order number.
          </p>
        </div>
      </div>
      <StepFooter
        onBack={onBack}
        onSkip={onSkip}
        primary={
          <LoadingButton
            onClick={dirty ? save : onNext}
            loading={busy}
            loadingText="Saving"
            className="gap-1.5"
          >
            {dirty ? "Save and continue" : "Continue"}
            <ArrowRightIcon className="size-3.5" />
          </LoadingButton>
        }
      />
    </div>
  );
}

/* ───────────────────────────── Step 3: Branding ─────────────────────────── */

function BrandingStep({
  branding,
  onNext,
  onBack,
  onSkip,
}: {
  branding: BrandingProp;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  const [brandName, setBrandName] = useState(branding.brandName);
  const [color, setColor] = useState(branding.primaryColor);
  const [busy, setBusy] = useState(false);
  const dirty =
    brandName !== branding.brandName || color !== branding.primaryColor;

  async function save() {
    setBusy(true);
    try {
      await api.patch("/api/admin/branding", {
        brandName,
        primaryColor: color,
      });
      toast.success("Branding saved");
      onNext();
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "Could not save",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-[13.5px] text-muted-foreground">
        Your brand name + accent color appear in customer emails, on
        payment pages, and on the Stripe checkout. You can upload a logo
        later from{" "}
        <Link href="/app/admin/branding" className="underline">
          Branding settings
        </Link>
        .
      </p>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="brand-name">Display name</Label>
          <Input
            id="brand-name"
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
            maxLength={80}
            disabled={busy}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brand-color">Primary color</Label>
          <div className="flex items-center gap-3">
            <input
              id="brand-color"
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value.toUpperCase())}
              disabled={busy}
              className="h-10 w-16 cursor-pointer rounded border"
            />
            <Input
              value={color}
              onChange={(e) => setColor(e.target.value.toUpperCase())}
              maxLength={7}
              disabled={busy}
              className="w-28 font-mono text-[12px]"
            />
            <span
              aria-hidden
              className="inline-flex h-9 items-center rounded-md px-3 text-[12px] font-semibold text-white"
              style={{ backgroundColor: color }}
            >
              Preview
            </span>
          </div>
        </div>
      </div>
      <StepFooter
        onBack={onBack}
        onSkip={onSkip}
        primary={
          <LoadingButton
            onClick={dirty ? save : onNext}
            loading={busy}
            loadingText="Saving"
            className="gap-1.5"
          >
            {dirty ? "Save and continue" : "Continue"}
            <ArrowRightIcon className="size-3.5" />
          </LoadingButton>
        }
      />
    </div>
  );
}

/* ───────────────────────────── Step 4: Stripe ───────────────────────────── */

function StripeStep({
  configured,
  onNext,
  onBack,
  onSkip,
}: {
  configured: boolean;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <CreditCardIcon className="mt-1 size-5 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-[13.5px]">
            Connect your Stripe account so customers can actually pay.
            You&apos;ll need your Stripe secret key, paste it once, and
            we register the webhook automatically.
          </p>
          <p className="text-[12px] text-muted-foreground">
            Don&apos;t have a Stripe account?{" "}
            <a
              href="https://dashboard.stripe.com/register"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Create one in 2 minutes
            </a>{" "}
           , Stripe is free to sign up and free to use in test mode.
          </p>
        </div>
      </div>

      {configured ? (
        <Alert>
          <CheckCircle2Icon className="size-4 text-emerald-600" />
          <AlertTitle>Stripe is connected</AlertTitle>
          <AlertDescription>
            You can take payments right now. Continue to set up your first
            product.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="rounded-md border bg-muted/30 p-4">
          <p className="text-[12.5px] text-muted-foreground">
            We&apos;ll open the Gateways page in a new tab. Paste your
            Stripe secret key, click Connect, then come back here to
            continue.
          </p>
          <Button asChild className="mt-3 gap-1.5" size="sm">
            <a
              href="/app/admin/gateways"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Stripe connect
              <ExternalLinkIcon className="size-3.5" />
            </a>
          </Button>
        </div>
      )}

      <StepFooter
        onBack={onBack}
        onSkip={configured ? undefined : onSkip}
        primary={
          <Button onClick={onNext} className="gap-1.5">
            Continue
            <ArrowRightIcon className="size-3.5" />
          </Button>
        }
      />
    </div>
  );
}

/* ───────────────────────────── Step 5: Catalog ─────────────────────────── */

function CatalogStep({
  done,
  onNext,
  onBack,
  onSkip,
}: {
  done: boolean;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <PackageIcon className="mt-1 size-5 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-[13.5px]">
            Define what you sell. We&apos;ll preconfigure the order form
            and emails to match, whether it&apos;s a service appointment,
            a product, a subscription, or something else entirely.
          </p>
        </div>
      </div>

      {done ? (
        <Alert>
          <CheckCircle2Icon className="size-4 text-emerald-600" />
          <AlertTitle>Catalog is set up</AlertTitle>
          <AlertDescription>
            You have at least one item type defined. Continue to finish
            onboarding.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="rounded-md border bg-muted/30 p-4">
          <p className="text-[12.5px] text-muted-foreground">
            We&apos;ll open the business setup wizard in a new tab. Pick a
            template (or define a custom item type), then come back here.
          </p>
          <Button asChild className="mt-3 gap-1.5" size="sm">
            <a
              href="/app/onboarding/business-setup"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open business setup
              <ExternalLinkIcon className="size-3.5" />
            </a>
          </Button>
        </div>
      )}

      <StepFooter
        onBack={onBack}
        onSkip={done ? undefined : onSkip}
        primary={
          <Button onClick={onNext} className="gap-1.5">
            Continue
            <ArrowRightIcon className="size-3.5" />
          </Button>
        }
      />
    </div>
  );
}

/* ───────────────────────────── Step 6: Done ─────────────────────────────── */

function DoneStep({
  onboardingSteps,
  onFinish,
  onBack,
}: {
  onboardingSteps: OnboardingStepsProp;
  onFinish: () => void;
  onBack: () => void;
}) {
  const checklist: Array<[label: string, done: boolean, href?: string]> = [
    [
      "Stripe connected",
      onboardingSteps.gatewayConfigured,
      "/app/admin/gateways",
    ],
    [
      "Catalog has at least one item type",
      onboardingSteps.businessSetupDone,
      "/app/onboarding/business-setup",
    ],
    [
      "Branding configured",
      onboardingSteps.brandingSet,
      "/app/admin/branding",
    ],
  ];
  const allRequired = checklist.every(([, done]) => done);

  return (
    <div className="space-y-6 text-center">
      <div className="mx-auto inline-flex size-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
        <SparklesIcon className="size-6" />
      </div>
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">
          {allRequired ? "You're set up." : "Almost there."}
        </h2>
        <p className="text-[14px] text-muted-foreground">
          {allRequired
            ? "Create your first order and start taking payments."
            : "Wrap up the remaining items below, then create your first order."}
        </p>
      </div>

      <ul className="mx-auto max-w-md space-y-2 text-left">
        {checklist.map(([label, done, href]) => (
          <li
            key={label}
            className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-[13px]"
          >
            {done ? (
              <CheckCircle2Icon className="size-4 text-emerald-600 shrink-0" />
            ) : (
              <CircleIcon className="size-4 text-muted-foreground shrink-0" />
            )}
            <span className="flex-1">{label}</span>
            {!done && href ? (
              <Link
                href={href}
                className="text-[12px] underline text-muted-foreground"
              >
                Open
              </Link>
            ) : null}
            {done ? <Badge variant="outline">Done</Badge> : null}
          </li>
        ))}
      </ul>

      <StepFooter
        onBack={onBack}
        primary={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href="/app/orders/create">Create first order</Link>
            </Button>
            <Button onClick={onFinish}>Go to dashboard</Button>
          </div>
        }
      />
    </div>
  );
}

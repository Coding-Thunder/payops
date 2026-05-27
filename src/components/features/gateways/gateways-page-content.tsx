"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  KeyIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
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
import { PaymentGatewayKey } from "@/lib/constants/enums";
import { connectStripeSchema } from "@/lib/validation";
import type { z } from "zod";

// Form binds to the schema's INPUT shape (before transforms) — RHF v7
// resolvers expect the value type to be assignable to the field types.
type ConnectStripeFormInput = z.input<typeof connectStripeSchema>;

/**
 * Pass 6a — Stripe auto-connect onboarding.
 *
 * Two-step flow:
 *   1. (Optional) Click "Test connection" — server hits Stripe's
 *      /v1/balance with the pasted key. ✓ if Stripe accepts, ✗ with a
 *      friendly reason if not.
 *   2. Click "Connect Stripe" — server verifies, auto-registers our
 *      webhook endpoint on the operator's Stripe account, captures
 *      the signing secret on the create response, persists both
 *      encrypted. The operator never has to leave this page or visit
 *      Stripe's Webhooks settings.
 *
 * Only Stripe is supported. Other gateway stubs (Razorpay / PayPal /
 * Authorize.net) were removed in Pass 6a — we'll add them back the
 * day we have a real adapter for each.
 */

interface SavedCredentialDTO {
  orgId: string;
  gateway: PaymentGatewayKey;
  mode: "LIVE" | "TEST";
  enabled: boolean;
  publishableKey: string | null;
  accountId: string | null;
  secretKeyLast4: string;
  configuredAt: string;
  updatedAt: string;
}

interface GatewaysPageContentProps {
  items: SavedCredentialDTO[];
  orgId: string | null;
  canEdit: boolean;
  encryptionAvailable: boolean;
  webhookUrlBase: string;
}

export function GatewaysPageContent({
  items,
  orgId,
  canEdit,
  encryptionAvailable,
  webhookUrlBase,
}: GatewaysPageContentProps) {
  const stripe = items.find(
    (i) => i.gateway === PaymentGatewayKey.STRIPE && i.enabled,
  );

  if (!encryptionAvailable) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Master encryption key not configured</AlertTitle>
        <AlertDescription>
          Set <code>PAYOPS_MASTER_KEY</code> in the deployment environment
          before saving any gateway credentials. Generate one with{" "}
          <code>openssl rand -base64 32</code>.
        </AlertDescription>
      </Alert>
    );
  }

  if (!orgId) {
    return (
      <Alert>
        <AlertTitle>No organization on this account</AlertTitle>
        <AlertDescription>
          Your account isn&apos;t attached to an organization yet. Visit{" "}
          <Link href="/signup" className="underline">
            sign-up
          </Link>{" "}
          or contact your administrator.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {stripe ? (
        <ConnectedStripeCard credential={stripe} canEdit={canEdit} />
      ) : (
        <ConnectStripeCard
          canEdit={canEdit}
          webhookUrlBase={webhookUrlBase}
          orgId={orgId}
        />
      )}
    </div>
  );
}

/* ─────────────────────────── Already-connected view ─────────────────── */

function ConnectedStripeCard({
  credential,
  canEdit,
}: {
  credential: SavedCredentialDTO;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function disconnect() {
    if (
      !confirm(
        "Disconnect Stripe? New orders will fail until you reconnect. We'll also remove the webhook endpoint we registered on your Stripe account.",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.del(`/api/admin/gateways/${PaymentGatewayKey.STRIPE}`);
      toast.success("Stripe disconnected");
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "Could not disconnect",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-3">
          Stripe
          <Badge variant={credential.mode === "LIVE" ? "default" : "secondary"}>
            {credential.mode === "LIVE" ? "Live mode" : "Test mode"}
          </Badge>
          <Badge variant="outline" className="gap-1">
            <CheckCircle2Icon className="size-3 text-emerald-600" />
            Connected
          </Badge>
        </CardTitle>
        {canEdit ? (
          <Button
            variant="outline"
            size="sm"
            onClick={disconnect}
            disabled={busy}
          >
            Disconnect
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border border-emerald-200/60 bg-emerald-50/50 px-3 py-2 text-[12.5px] text-emerald-900">
          <ShieldCheckIcon className="-mt-0.5 mr-1 inline size-3.5" />
          PayOps is connected to your Stripe account and webhooks are
          registered automatically. You can start taking payments.
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-muted-foreground">Secret key</dt>
          <dd className="font-mono">••••{credential.secretKeyLast4}</dd>
          {credential.accountId ? (
            <>
              <dt className="text-muted-foreground">Account id</dt>
              <dd className="font-mono">{credential.accountId}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Connected</dt>
          <dd>{new Date(credential.configuredAt).toLocaleString()}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}

/* ────────────────────────────── Connect form ────────────────────────── */

interface TestResult {
  ok: boolean;
  message: string;
}

function ConnectStripeCard({
  canEdit,
  webhookUrlBase,
  orgId,
}: {
  canEdit: boolean;
  webhookUrlBase: string;
  orgId: string;
}) {
  const router = useRouter();
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const previewCallbackUrl = `${webhookUrlBase.replace(
    /\/$/,
    "",
  )}/api/webhooks/stripe/${orgId}`;

  const form = useForm<ConnectStripeFormInput>({
    resolver: zodResolver(connectStripeSchema),
    defaultValues: {
      mode: "TEST",
      secretKey: "",
      publishableKey: "",
      accountId: "",
    },
    mode: "onTouched",
  });

  async function handleTest() {
    setTestResult(null);
    const values = form.getValues();
    if (!values.secretKey || values.secretKey.length < 10) {
      setTestResult({ ok: false, message: "Paste your secret key first." });
      return;
    }
    setTesting(true);
    try {
      const res = await api.post<
        | { ok: true; livemode: boolean; accountId: string | null }
        | { ok: false; message: string }
      >("/api/admin/gateways/stripe/test", {
        mode: values.mode,
        secretKey: values.secretKey,
      });
      if (res.ok) {
        setTestResult({
          ok: true,
          message: `Stripe accepts this key (${
            res.livemode ? "LIVE" : "TEST"
          } mode${res.accountId ? ` · ${res.accountId}` : ""}).`,
        });
      } else {
        setTestResult({ ok: false, message: res.message });
      }
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof ApiClientError ? err.message : "Could not test",
      });
    } finally {
      setTesting(false);
    }
  }

  async function onSubmit(values: ConnectStripeFormInput) {
    try {
      await api.post("/api/admin/gateways/stripe/connect", values);
      toast.success(
        "Stripe connected. We've registered the webhook endpoint for you.",
      );
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof ApiClientError
          ? err.message
          : "Could not connect to Stripe",
      );
    }
  }

  return (
    <div className="space-y-4">
      <NoAccountYetCard />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            Connect Stripe
            <Badge variant="outline">Not configured</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-4"
            >
              <FormField
                control={form.control}
                name="mode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mode</FormLabel>
                    <FormControl>
                      <Select
                        value={field.value}
                        onValueChange={(v) => field.onChange(v)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="TEST">
                            Test mode (recommended to start)
                          </SelectItem>
                          <SelectItem value="LIVE">
                            Live mode (real money)
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormDescription>
                      Start in <strong>Test</strong> mode. You can switch
                      to Live once you&apos;ve placed a few sandbox orders.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="secretKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      <KeyIcon className="size-3.5" />
                      Stripe secret key
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="password"
                        autoComplete="off"
                        placeholder={
                          form.watch("mode") === "TEST"
                            ? "sk_test_…"
                            : "sk_live_…"
                        }
                        disabled={!canEdit}
                      />
                    </FormControl>
                    <FormDescription>
                      Find this at{" "}
                      <a
                        href={
                          form.watch("mode") === "TEST"
                            ? "https://dashboard.stripe.com/test/apikeys"
                            : "https://dashboard.stripe.com/apikeys"
                        }
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5 underline"
                      >
                        Stripe dashboard → Developers → API keys
                        <ExternalLinkIcon className="size-3" />
                      </a>
                      . Look for &quot;Secret key&quot; — click{" "}
                      <em>Reveal</em> and copy the <code>sk_…</code> value.
                      We encrypt it before saving and never display the
                      full value again.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="publishableKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Publishable key{" "}
                      <span className="font-normal text-muted-foreground">
                        (optional)
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        placeholder={
                          form.watch("mode") === "TEST"
                            ? "pk_test_…"
                            : "pk_live_…"
                        }
                        disabled={!canEdit}
                      />
                    </FormControl>
                    <FormDescription>
                      Reserved for client-side flows that render Stripe
                      Elements directly. Safe to expose to browsers.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2.5 text-[12px]">
                <p className="font-medium text-foreground">
                  What happens when you click Connect
                </p>
                <ol className="list-decimal space-y-0.5 pl-5 text-muted-foreground">
                  <li>
                    We call Stripe with your secret key to confirm it works.
                  </li>
                  <li>
                    We register PayOps as a webhook endpoint at{" "}
                    <code className="break-all text-[11px]">
                      {previewCallbackUrl}
                    </code>{" "}
                    on your Stripe account.
                  </li>
                  <li>
                    We capture the signing secret Stripe returns and store
                    it encrypted.
                  </li>
                </ol>
              </div>

              {testResult ? (
                <Alert variant={testResult.ok ? "default" : "destructive"}>
                  {testResult.ok ? (
                    <CheckCircle2Icon className="size-4 text-emerald-600" />
                  ) : (
                    <XCircleIcon className="size-4" />
                  )}
                  <AlertDescription>{testResult.message}</AlertDescription>
                </Alert>
              ) : null}

              <div className="flex items-center gap-2 pt-2">
                <LoadingButton
                  type="submit"
                  loading={form.formState.isSubmitting}
                  disabled={!canEdit}
                >
                  Connect Stripe
                </LoadingButton>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleTest}
                  disabled={!canEdit || testing}
                >
                  {testing ? "Testing…" : "Test connection"}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}

function NoAccountYetCard() {
  return (
    <Card className="border-dashed bg-muted/30">
      <CardContent className="flex items-center justify-between gap-4 py-4">
        <div className="space-y-0.5">
          <p className="text-[13px] font-medium">
            Don&apos;t have a Stripe account yet?
          </p>
          <p className="text-[12px] text-muted-foreground">
            Create one in a couple of minutes — Stripe is free to sign up
            and free to use in test mode.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <a
            href="https://dashboard.stripe.com/register"
            target="_blank"
            rel="noreferrer"
          >
            Create Stripe account
            <ExternalLinkIcon className="size-3" />
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}

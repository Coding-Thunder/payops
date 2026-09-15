import type { NextRequest } from "next/server";
import { z } from "zod";

import { BetaUserType } from "@/lib/constants/beta";
import {
  attributionForStorage,
  attributionSchema,
} from "@/lib/validation/attribution";
import { disposableEmailRefinement } from "@/lib/validation/disposable-email";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { verifyTurnstile } from "@/server/auth/turnstile";
import { submitApplication } from "@/server/services/beta-application.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public "Join the Beta" submission. Server-validated + normalized, rate
 * limited, Turnstile-gated (when configured), length-capped, and CSRF-safe
 * via the same-origin check in `withApi`. Stores a PENDING application; never
 * creates an account. Always responds identically so a specific email being
 * already-applied is never observable.
 */
const applySchema = z.object({
  fullName: z.string().trim().min(2, "Please enter your name").max(160),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email")
    .max(254)
    // Server-side, so a client that skips the form cannot bypass it.
    .refine(...disposableEmailRefinement),
  userType: z.enum([
    BetaUserType.FREELANCER,
    BetaUserType.AGENCY_OWNER,
    BetaUserType.OTHER,
  ]),
  businessName: z.string().trim().max(200).optional(),
  clientsManaged: z.string().trim().max(40).optional(),
  challengeAnswer: z.string().trim().max(4000).optional(),
  cfToken: z.string().max(2048).optional(),
  // Marketing attribution, captured client-side. Optional by design: a direct
  // visit has none, and a lead must never be lost over reporting metadata.
  // Each field is length-capped by `attributionSchema`; unknown keys are
  // stripped, so a crafted body cannot add fields to the stored document.
  attribution: attributionSchema.nullish(),
});

export const POST = withApi(
  async (req: NextRequest) => {
    const body = await req.json();
    const input = applySchema.parse(body);
    const ctx = await getRequestContext();
    await verifyTurnstile({ token: input.cfToken, remoteIp: ctx.ip });

    await submitApplication({
      fullName: input.fullName,
      email: input.email,
      userType: input.userType,
      businessName: input.businessName || null,
      clientsManaged: input.clientsManaged || null,
      challengeAnswer: input.challengeAnswer || null,
      attribution: attributionForStorage(input.attribution),
    });

    // Constant response — never reveals whether this email already applied.
    return jsonOk({ ok: true });
  },
  {
    rateLimit: { route: "beta-apply", max: 5, windowMs: 15 * 60_000 },
    bodyLimitBytes: 8 * 1024,
  },
);

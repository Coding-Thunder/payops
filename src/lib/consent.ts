import { ConsentStatus } from "@/lib/constants/enums";

/**
 * Has the customer given consent for this order?
 *
 * Both RECEIVED and VERIFIED count. A customer who confirms on the hosted
 * page lands on VERIFIED directly — the submission is itself the
 * verification — while RECEIVED is what an operator-recorded reply produces
 * before review. Checking for RECEIVED alone refused every hosted-page
 * consent, which blocked recording a manual payment for every customer who
 * had done exactly what they were asked.
 *
 * Shared by the service and the operator UI so the two cannot disagree.
 */
export function hasCustomerConsent(
  status: ConsentStatus | null | undefined,
): boolean {
  return status === ConsentStatus.RECEIVED || status === ConsentStatus.VERIFIED;
}

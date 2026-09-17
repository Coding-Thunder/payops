/**
 * Default subject for a payment request. A manual request asks the customer
 * to confirm the booking — nothing is paid online — so it must not say
 * "complete your payment". Shared by the composer and the server default.
 */
export function paymentRequestSubject(
  providerName: string,
  orderNumber: string,
  manual: boolean,
): string {
  return manual
    ? `Please confirm your ${providerName} booking • ${orderNumber}`
    : `Complete your ${providerName} payment • ${orderNumber}`;
}

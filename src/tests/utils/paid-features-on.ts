/**
 * Test double for `@/lib/paid-features`: the paid features, switched ON.
 *
 * The features are disabled by default (they have not been paid for), so a
 * test that exercises one opts in explicitly:
 *
 *   vi.mock("@/lib/paid-features", () => import("@/tests/utils/paid-features-on"));
 */
export const PAID_FEATURES_ENABLED = true;
export function assertPaidFeaturesEnabled(): void {}

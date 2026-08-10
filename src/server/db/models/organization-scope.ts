import { Schema, type Types } from "mongoose";

/**
 * Marks a collection as organization-owned and gives it its tenancy column.
 *
 * Applied via `schema.plugin(organizationScope)` at the bottom of each
 * owning model. Grepping for that call is the authoritative answer to
 * "which collections are scoped by organization" — worth more than eleven
 * copies of the same field definition drifting apart over time.
 *
 * The field is NULLABLE ON PURPOSE, and stays that way for now.
 *
 * Every row written before organizations existed has no value here, and a
 * required column would make each of those documents fail validation on the
 * next save — i.e. it would break production the moment it deployed. So the
 * order is: add the column nullable (this phase), backfill it in a
 * re-runnable script, verify, and only then consider tightening. Until that
 * last step, the scoping helper treats null as "belongs to the default
 * organization", so no historical record can become unreachable even
 * mid-backfill.
 *
 * NOTE ON INDEXES: production runs `autoIndex: false`
 * (`src/server/db/mongoose.ts`), so the index declared here does NOT come
 * into existence on deploy. It must be created by `scripts/build-indexes.ts`.
 * Until it exists, scoped queries still return correct results — they just
 * collection-scan. Correctness does not depend on the index; latency does.
 */

/** Mixed into every organization-owned document interface. */
export interface OrganizationScoped {
  /**
   * Owning organization. `null` / absent means the record pre-dates the
   * migration; readers resolve that to the default organization rather than
   * treating it as orphaned.
   */
  organizationId?: Types.ObjectId | null;
}

export function organizationScope(schema: Schema): void {
  schema.add({
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
    },
  });

  // Sparse: only documents that have been attributed are indexed, so this
  // costs nothing on a collection that has not been backfilled yet, and the
  // index does not bloat with a null entry per historical row.
  schema.index({ organizationId: 1 }, { sparse: true });
}

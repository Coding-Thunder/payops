/**
 * Rental-provider seed catalog.
 *
 * Providers live in the database (see `Provider` model + `provider.service`)
 * so admins can add/edit/disable them at runtime. This file is now the
 * *seed* set: on first boot, `ensureSeedProviders()` inserts these records
 * if the collection is empty.
 *
 * `resolveProvider()` operates on the snapshot stored on an order — no DB
 * read needed — so legacy data, deleted providers, and renamed providers
 * all continue to render correctly on historical orders/receipts.
 */

/** Well-known keys shipped with the seed catalog. Code never narrows the
 *  full provider universe to this enum — additional keys are created at
 *  runtime by admins. Kept around as ergonomic constants for tests/seed. */
export const ProviderId = {
  BUDGET: "BUDGET",
  THRIFTY: "THRIFTY",
  HERTZ: "HERTZ",
  DOLLAR: "DOLLAR",
  ENTERPRISE: "ENTERPRISE",
  ALAMO: "ALAMO",
} as const;
export type ProviderId = (typeof ProviderId)[keyof typeof ProviderId];
export const PROVIDER_IDS = Object.values(ProviderId) as ProviderId[];

/** Validation regex for any provider key (seed or admin-created). */
export const PROVIDER_KEY_REGEX = /^[A-Z][A-Z0-9_]{1,31}$/;

export interface ProviderMetadata {
  /** Stable uppercase identifier — never displayed. */
  id: string;
  /** Customer-facing brand name. */
  name: string;
  /** Public path to the brand mark (served from /public). */
  logo: string;
  /** Primary brand colour (hex). Used for chips, email header bars, accents. */
  primaryColor: string;
  /** Text colour that reads on top of `primaryColor`. */
  onPrimaryColor: string;
  /** Optional alternate logo for dark backgrounds. Falls back to `logo`. */
  logoDark?: string;
  /** One-line marketing description, surfaced in the selector. */
  tagline: string;
}

/** Default seed records inserted on first boot. */
export const PROVIDER_SEED: Readonly<Record<ProviderId, ProviderMetadata>> = {
  [ProviderId.BUDGET]: {
    id: ProviderId.BUDGET,
    name: "Budget",
    logo: "/providers/budget.png",
    primaryColor: "#E8590C",
    onPrimaryColor: "#FFFFFF",
    tagline: "Value-focused rentals",
  },
  [ProviderId.THRIFTY]: {
    id: ProviderId.THRIFTY,
    name: "Thrifty",
    logo: "/providers/thrifty.png",
    primaryColor: "#0B5BA8",
    onPrimaryColor: "#FFFFFF",
    tagline: "Mid-tier business fleets",
  },
  [ProviderId.HERTZ]: {
    id: ProviderId.HERTZ,
    name: "Hertz",
    logo: "/providers/hertz.png",
    primaryColor: "#F1B500",
    onPrimaryColor: "#111111",
    tagline: "Premium global network",
  },
  [ProviderId.DOLLAR]: {
    id: ProviderId.DOLLAR,
    name: "Dollar",
    logo: "/providers/dollar.gif",
    primaryColor: "#C8242F",
    onPrimaryColor: "#FFFFFF",
    tagline: "Everyday low-rate rentals",
  },
  [ProviderId.ENTERPRISE]: {
    id: ProviderId.ENTERPRISE,
    name: "Enterprise",
    logo: "/providers/enterprise.webp",
    primaryColor: "#0A6E3B",
    onPrimaryColor: "#FFFFFF",
    tagline: "Corporate & long-term rentals",
  },
  [ProviderId.ALAMO]: {
    id: ProviderId.ALAMO,
    name: "Alamo",
    logo: "/providers/alamo.png",
    primaryColor: "#1E3A8A",
    onPrimaryColor: "#FFFFFF",
    tagline: "Leisure & airport rentals",
  },
};

/**
 * @deprecated Kept for backward compatibility with code that imports the
 * static array. New code should fetch from the DB via `listActiveProviders()`.
 */
export const PROVIDER_METADATA = PROVIDER_SEED;
/** @deprecated Use {@link listActiveProviders} from the API instead. */
export const PROVIDERS: readonly ProviderMetadata[] = PROVIDER_IDS.map(
  (id) => PROVIDER_SEED[id],
);

/** Snapshot stored on each order. Frozen at creation time. Colours are
 *  optional for back-compat with rows written before the colour fields
 *  existed — render code falls back to a neutral palette. */
export interface ProviderSnapshot {
  id: string;
  name: string;
  logo: string;
  primaryColor?: string;
  onPrimaryColor?: string;
}

export const UNKNOWN_PROVIDER: ProviderMetadata = {
  id: "UNKNOWN",
  name: "Unspecified provider",
  logo: "/providers/_placeholder.svg",
  primaryColor: "#64748B",
  onPrimaryColor: "#FFFFFF",
  tagline: "Provider not recorded on this order",
};

export function isValidProviderKey(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_KEY_REGEX.test(value);
}

/**
 * Resilient lookup for legacy / stored data. Works off the snapshot itself
 * so it never needs a DB call. Returns a synthesised "unknown" record when
 * the snapshot is absent.
 *
 * Note: admin-created providers won't have brand colours/tagline available
 * here — those metadata fields are only known to seed providers and to the
 * live DB catalog. For surfaces that need colour (cards, email header), pass
 * the DTO from the server-rendered list instead of resolving from a snapshot.
 */
export function resolveProvider(
  snapshot: ProviderSnapshot | { id?: string | null } | null | undefined,
): ProviderMetadata {
  const id = snapshot?.id;
  if (!id) return UNKNOWN_PROVIDER;
  const seed = (PROVIDER_SEED as Record<string, ProviderMetadata>)[id];
  if (seed) return seed;
  // Admin-created provider: synthesise from what the snapshot carries plus
  // a neutral palette. Real metadata is available from the DB-backed list.
  const name =
    snapshot && "name" in snapshot && typeof snapshot.name === "string"
      ? snapshot.name
      : id;
  const logo =
    snapshot && "logo" in snapshot && typeof snapshot.logo === "string"
      ? snapshot.logo
      : UNKNOWN_PROVIDER.logo;
  const primaryColor =
    snapshot &&
    "primaryColor" in snapshot &&
    typeof snapshot.primaryColor === "string"
      ? snapshot.primaryColor
      : UNKNOWN_PROVIDER.primaryColor;
  const onPrimaryColor =
    snapshot &&
    "onPrimaryColor" in snapshot &&
    typeof snapshot.onPrimaryColor === "string"
      ? snapshot.onPrimaryColor
      : UNKNOWN_PROVIDER.onPrimaryColor;
  return {
    id,
    name,
    logo,
    primaryColor,
    onPrimaryColor,
    tagline: "",
  };
}

/** Build the canonical snapshot to persist on a new order — when you only
 *  have static seed data. For DB-backed providers use `provider.service`. */
export function buildProviderSnapshot(id: string): ProviderSnapshot {
  const meta = (PROVIDER_SEED as Record<string, ProviderMetadata>)[id];
  if (meta) {
    return {
      id: meta.id,
      name: meta.name,
      logo: meta.logo,
      primaryColor: meta.primaryColor,
      onPrimaryColor: meta.onPrimaryColor,
    };
  }
  return {
    id,
    name: id,
    logo: UNKNOWN_PROVIDER.logo,
    primaryColor: UNKNOWN_PROVIDER.primaryColor,
    onPrimaryColor: UNKNOWN_PROVIDER.onPrimaryColor,
  };
}

/** @deprecated Old name. Use {@link isValidProviderKey}. */
export const isProviderId = isValidProviderKey;

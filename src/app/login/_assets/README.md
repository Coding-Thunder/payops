# Login background asset

`login-bg.jpg`

| | |
|---|---|
| Source | Unsplash — https://unsplash.com/photos/PXjQaGxi4JA |
| Photographer | Hector Reyes |
| Original | `hector-reyes-PXjQaGxi4JA-unsplash.jpg`, 5074 × 7607, 3.1 MB |
| Committed | 1601 × 2400, JPEG q72, ~425 KB |
| Licence | [Unsplash Licence](https://unsplash.com/license) — free to use, commercial use permitted, attribution not required |

## Why it is committed rather than uploaded

This is a **build-time** asset, not operator-uploaded content, so it belongs
in the repository. `next/image` fingerprints it into
`/_next/static/media/<hash>` and serves it immutable for a year, generating
AVIF/WebP and a responsive srcset — no database read and no request-time
work on the login path.

That is a different case from provider and branding logos, which an operator
uploads at runtime and which therefore live in the GridFS asset store
(`src/server/storage/asset-store.ts`). The bug that store exists to fix was
writing to `public/` **at runtime**; a file present when the container is
built has never had that problem, which is why the six seeded provider logos
have always served correctly.

## Rights note

The Unsplash Licence covers the photographer's copyright in the photograph
and permits commercial use. It does **not** grant rights in the character
depicted, which is owned by Marvel — Unsplash's terms note that images may
contain trademarks or other elements requiring separate permission. Sourcing
was chosen deliberately by the product owner; recorded here so the position
is documented rather than assumed.

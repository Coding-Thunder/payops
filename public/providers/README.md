# Provider brand marks

The SVGs in this directory are clean, brand-tone placeholder marks used by the
provider/brand system (see `src/lib/constants/providers.ts`). They are NOT the
official trademarked logos of the listed rental companies — each is a stylised
initial inside the provider's known brand colour.

## When to swap in real assets

Before going live to real customers, replace each file in-place with the
licensed brand mark:

- `budget.svg`
- `thrifty.svg`
- `hertz.svg`
- `dollar.svg`
- `enterprise.svg`
- `alamo.svg`

Asset requirements:
- SVG with transparent background (PNG also acceptable, update the `logo:`
  path in `PROVIDER_METADATA` accordingly)
- 1:1 aspect ratio, padded so the mark sits comfortably inside a square frame
- Optimised — strip editor metadata, keep file size under ~6 KB

No other code needs to change — `ProviderLogo`, `ProviderBadge`,
`ProviderCard`, `ProviderSelector`, and `EmailProviderHeader` all read from
the central registry.

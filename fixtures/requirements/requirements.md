# Demo Client: Customer Portal requirements

Synthetic requirements for the CommonForge demo project. Nothing here describes a
real customer.

## R1. Instant quote

- R1.1 A visitor can request a quote by choosing a plan (`starter`, `team`,
  `enterprise`), a seat count (1 to 10,000) and a company name.
- R1.2 The quote shows the unit price per seat, the total in USD and the date the
  quote stays valid until (30 days after the pricing date).
- R1.3 Pricing per seat per month: starter 12 USD, team 29 USD, enterprise 59 USD.
- R1.4 Volume discount: 10% off the total from 50 seats, 20% off from 250 seats.

## R2. Contract

- R2.1 The quote response shape is defined by `contracts/quote.schema.json`.
  The website validates every response against it in its contract test.
- R2.2 Any new response field must be added to the contract before the api ships
  it. The contract is strict (`additionalProperties: false`).

## R3. Version endpoint

- R3.1 The api exposes `GET /version` returning the service name and the
  deployed version, used as the post-publish health check.

## R4. Brand

- R4.1 The portal header shows the Demo Client logo (`brand-assets/logo.png`).
- R4.2 The brand colour is teal (`#0f766e`) on a light background.

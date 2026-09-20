# Recoup product plan: useful to everyone

Date: 2026-09-20. Sits on top of `2026-09-20-recoup-iterations.md`. Based on a 30-day community scan (Reddit, YouTube, Hacker News, GitHub, web; X was not reachable from this machine) plus targeted web research. Raw research: `~/Documents/Last30Days/price-tracking-and-price-drop-alert-apps-raw-v3.md`. The social scan returned little on-topic signal; most of what follows rests on the targeted searches, and that is said plainly so nobody over-trusts it.

Decisions already made by Charlie: notifications by email through AgentMail; pitch line "Price dropped after you bought? Recoup gets the difference back. Haven't bought yet? It watches the price everywhere and tells you when to."; the returns-credit story is out of the pitch and UI.

## What the research says

1. **The "get money back after a price drop" category is empty because the last generation killed it.** Paribus (bought by Capital One, shut down by early 2023) and Earny (dormant since 2022) filed claims automatically at scale. Earny reportedly filed more claims in an hour than card issuers used to see in a year, and issuers and merchants responded by removing or restricting the benefits. Lesson for Recoup: **never auto-file**. One claim, one human-approved message, stated in the store's own policy words. That is already our design (D03, D11, D18); it is now the core positioning, not just a safety rule.
2. **Trust in shopping tools is broken.** Honey was exposed for replacing creators' affiliate cookies and favouring partner coupons over better ones; millions uninstalled, creators dropped it, a class action followed, and PayPal disabled the practices in January 2026. Lesson: **no affiliate links, no sponsored ranking, say so on the first screen**, and show the evidence (source page, time checked) behind every price.
3. **Incumbent trackers are Amazon-first and built for power users.** Keepa has the deepest data but is paid, dense and Amazon-only; CamelCamelCamel is free and simple but Amazon-only; Honey spans stores but has thin history. Alert emails arrive late or in spam.
4. **The open-source scene shows what works technically.** PriceBuddy, PriceStalker, Discount-Bandit and PriceGhost all converge on: paste any URL, per-site selectors with an AI fallback, several extraction methods that vote on the price, stock status, many notification channels. They are self-hosted, so a normal person cannot use them. That is our opening: the same capability with zero setup.
5. **"Is this deal real?" is the question normal people actually have.** Studies keep finding most retailers run fake sales; for 12 of 25 tracked retailers more than half of items were at false discounts most weeks. People are told to start watching six to eight weeks before Black Friday. It is late September: the timing is exactly right.
6. **Price is not only the sticker.** Shipping, tax, coupons, membership prices and stock status change which store is actually cheapest.

## Who it is for, in plain words

Someone who is about to buy something that costs enough to care about, and does not want to feel cheated next week. They will not install an extension, learn a chart, or write an email to customer service. They will paste a link.

## Product principles

1. **Paste a link, get an answer.** No extension, no setup, no jargon. The first screen has one box.
2. **Give a verdict, not a chart.** "Good price", "Wait", "Fake discount", each with one sentence of why. The chart is there if you tap.
3. **You approve everything that leaves your name.** We draft; you send. We never file claims in bulk.
4. **We only count money you confirm you received.**
5. **No affiliate links, no sponsored placement.** Ranking is by total price and nothing else.
6. **Show the receipts.** Every price has a source link and a time. Every policy has the exact sentence it came from.

## Feature plan, on top of the iteration plan

### Tier 1: inside the hackathon (the iteration plan's W1 to W3, sharpened)

| # | Feature | Layman value | Build note |
|---|---|---|---|
| W1 | **Paste-a-link watch** with optional target price | "Tell me when this gets cheaper" | `watches` table; reuse price extractor, cron and "check now". Accept a product name too and let Firecrawl search find the page |
| W1b | **Verdict line** on every watched or owned item: Good price / Fair / Wait / Discount looks inflated | Answers "should I buy now?" without reading a chart | Pure function over our own `priceChecks` history plus the page's claimed "was" price, which the extractor already sees. With under a week of history the verdict says "not enough history yet", never a guess |
| W2 | **Drop email** to the account address, once per item per price, with the reason and one button back to the item | The whole point of watching | AgentMail send, dedupe key `watch:itemId:cents` (pattern from bipolar `notify.ts`) |
| W3 | **Same item at other stores**, ranked cheapest first, user confirms matches | "Where is it cheapest right now?" | Firecrawl search, variant-match check, user confirmation. No Facebook Marketplace; Amazon and eBay only when the public page is readable |
| W4 | **"You already bought this" bridge**: when a watched item is marked bought, it becomes a purchase with its price-adjustment window counting down | The part nobody else does | Converts a watch into a purchase; everything after that is already built |
| T1 | **Trust line in the UI and `hackathon.md`**: no affiliate links, you approve every message, money counts only when you confirm it | Differentiates from Honey in one sentence | Copy only |

### Tier 2: first month after the hackathon

- **Total price**: shipping, tax estimate by ZIP, membership price flagged separately, coupon shown only if publicly listed on the store's own page.
- **Back-in-stock and size/colour watch** (open-source trackers show this is heavily used).
- **More channels**: browser push, Telegram, SMS. Email stays the default.
- **Price-match before you buy**: if store A is dearer but has a price-match policy and store B is cheaper, say "buy at A and ask for B's price", with the policy sentence.
- **Shared policy library** across users: window, channel, contact, response rate per merchant. Compounds with every claim.
- **Inbox connection** (Gmail/Outlook read-only) so purchases appear without forwarding.
- **Card price-protection check**: tell the user whether their card still offers it; never file on their behalf in bulk.
- **Share a watch** with a partner or family member; gift lists.

### Tier 3: generalise beyond shopping (same engine: policy, exact amount, approved ask, confirmed money)

Flights and hotels (fare drops, EU261 delay compensation), subscription price rises and double billing, late-delivery guarantees, outage and SLA credits, small-business vendor credits. Add one at a time, each as a claim type with its own detector, policy source and amount formula.

## Risks and how the plan handles them

| Risk | Handling |
|---|---|
| Retailers tighten price-adjustment policies if tools abuse them (the Paribus and Earny outcome) | Human-approved single messages, per-user rate limits, no bulk filing, polite drafts that cite the store's own words |
| Sites block automated reads | Firecrawl first; honest "could not read this page" state; user can enter a price by hand; never pretend a stale price is current |
| Wrong product matched across stores | Variant-match check plus user confirmation; unconfirmed offers are shown greyed and never drive a verdict or an alert |
| Thin price history on day one | Verdict refuses to judge without history; say so; consider a licensed history source later |
| Alert emails land in spam or arrive late | One email per real event, plain text, clear subject; in-app drops list as the backstop; per-watch cadence on the cron |
| Crowded category | Do not compete on Amazon chart depth. Compete on: any store, plain verdict, no affiliate conflict, and money back after purchase |

## Order of work

1. Finish I2 and I3 (purchase intake and policy lookup), then I6 (price drop after purchase), then I4 and I5 (ask and reply) on a price claim.
2. W1 and W1b together, then W2, then W4, then W3. W3 is the first thing to cut if live bugs eat the slack; W4 is small and carries the story, so it goes before W3.
3. T1 copy changes ride along with the first UI touch.
4. I7 submission. Code freeze 2026-09-22 08:00 PT.

# Toll: Devpost submission (paste-ready)

## Project name
Toll

## Tagline (one line)
Pay-per-request for AI agents, settled with PayPal and guarded by plain-English spending rules.

## GitHub "About" description (repo page, gear icon)
Pay-per-request for AI agents, settled with PayPal. x402-style 402 paywall, plain-English spending firewall, live 3D money map.
Topics: paypal, ai-agents, x402, agentic-commerce

## Links
- Code: https://github.com/pavittt/toll
- Video: (your YouTube link)

---

## Inspiration
AI agents now browse, call APIs and buy data on their own. Websites want to be paid when agents use them, and a new pattern for that is HTTP `402 Payment Required`: the site names a price, the agent pays and continues. Today almost everything built on that pattern (the x402 protocol) runs on crypto wallets and stablecoins. Most developers and site owners don't want to touch crypto, but nearly all of them already trust PayPal.

The second problem is safety. An agent that can pay can also be tricked into paying. A single web page with hidden instructions can tell an agent to "buy a $500 verification pass." Nobody should hand an agent their card.

## What it does
Toll is a payment gateway and spending firewall for AI agents, built on PayPal.

- **For websites and APIs:** one line of Express middleware (`tollPaywall`) answers agents with `402` and a price, verifies the payment, and serves the content. Free pages stay free.
- **For agent owners:** a wallet funded with a real PayPal Checkout. You write rules in plain English, such as "$3 a day, never more than $0.25 on one thing, ask me above $0.10, no gift cards." AI compiles them into hard limits. Payments above your threshold wait for your tap.
- **For agents:** a drop-in `fetch` that handles `402` automatically, so it works with any agent framework. Our demo agent researches a topic across paid sites by itself.
- **Every payment goes through three layers:**
  1. Hard rules in code that no web page can talk its way around.
  2. An AI judge that checks whether the payment serves the agent's real task, and flags prompt injection and price gouging.
  3. Owner approval for anything above your threshold.
- **Settlement:** sites earn on a micro-dollar ledger and are paid in one PayPal Payouts batch. Unused balance is refunded back to PayPal.
- **A live 3D map** shows the agent, the sites and PayPal as a network, with money flowing in real time and blocked payments flashing red.

In the demo, the agent pays 1 to 5 cents for weather data, research summaries and news. Then it walks into a trap site whose hidden instructions demand $499 and $500. Toll blocks both and explains why, and the honest sites get paid out through PayPal.

## How we built it
- **Gateway:** Node.js, TypeScript, Express and SQLite. All money is held as integer micro-dollars with atomic debit and credit transactions.
- **Payment tokens:** HMAC-signed, single use, expire after 5 minutes, and bound to one merchant and one exact URL. Approved payments that are never used are returned to the wallet automatically.
- **PayPal:**
  - Orders v2 and the JavaScript SDK Buttons to fund the wallet.
  - Payouts v1 to pay sites in batches, with status tracking.
  - Payments v2 capture refunds to withdraw unused balance.
  - Webhooks with signature verification and idempotent crediting, so a capture and its webhook never credit twice.
- **Ledger:** PayPal can't move 2 cents profitably, so Toll works like a prepaid card. One real top-up funds the wallet, each request is a ledger entry, and only whole cents leave in payouts.
- **AI:** Google Gemini on its free tier, or Anthropic Claude. It compiles rules into a typed policy (structured JSON output validated with zod), judges each payment with a readable reason and risk signals, and powers the research agent through tool calling. The judge fails closed: any error means the payment is blocked.
- **Protocol:** follows the x402 shape (402 body with `accepts`, `X-PAYMENT` and `X-PAYMENT-RESPONSE` headers) with a new `toll-paypal` scheme.
- **Dashboard:** React, three.js and react-three-fiber, updated live over Server-Sent Events.
- **Tests:** automated tests for charging, token replay and binding, hard limits, daily caps, the AI judge path, approvals, refunds and idempotent top-ups. Plus an end-to-end smoke test of the 402 flow.

## Challenges we ran into
- **Micropayments on card rails.** Two-cent payments can't each be a PayPal transaction, so we designed a prepaid ledger with batch settlement and kept the books exact in micro-dollars.
- **Making the firewall impossible to talk around.** An AI judge alone can be manipulated by the same page that manipulates the agent. So hard limits run first in plain code, merchant text is passed to the judge only as untrusted evidence, and any judge failure blocks the payment.
- **Tokens that can't be replayed.** A token is bound to one merchant and one URL, can be used once, and expires.

## Accomplishments that we're proud of
- A working end-to-end flow: a real agent hits a paywall, pays and gets the content. The site gets paid out through PayPal.
- Watching the trap site's $499 charge get blocked, with the reason shown, while honest sites keep earning.
- Any website can start charging agents with one line of code.

## What we learned
Agent payments are mostly a trust problem, not a transfer problem. The hard part is deciding whether a payment should happen. Layering cheap deterministic rules under an AI judge, with a human for edge cases, gives both safety and autonomy.

## What's next for Toll
- Vaulted payment methods for automatic wallet refills.
- Per-agent sub-wallets for teams.
- Merchant onboarding through PayPal so sites get paid to their own accounts.
- Plug-ins for more frameworks (Next.js, FastAPI) and for the MCP tool ecosystem.
- Full interoperability with the x402 spec so one site can accept crypto and PayPal side by side.

## Built with
paypal-orders-api, paypal-payouts, paypal-javascript-sdk, paypal-webhooks, gemini, anthropic-claude, typescript, node.js, express, sqlite, react, three.js, react-three-fiber, vite, zod

---

# Video script (under 3 minutes, no music needed)

**0:00–0:15 Hook** (dashboard with the 3D map spinning)
"AI agents are starting to pay for things on their own. Websites want to charge them. But nobody should hand an agent their credit card. This is Toll."

**0:15–0:35 The problem**
"Sites charge agents with HTTP 402 Payment Required. Today that runs on crypto. Toll does it with PayPal, and puts a firewall between the agent and your money."

**0:35–0:55 Set the rules** (type and compile the rules, policy chips appear)
"I write my rules in plain English. AI turns them into hard limits: $3 a day, $0.25 max per payment, ask me above $0.10, no gift cards."

**0:55–1:15 Fund the wallet with PayPal** (click the PayPal button, sandbox checkout, balance jumps, blue particle from PayPal)
"I top up the agent's wallet with a normal PayPal Checkout. That's the only time a card is involved."

**1:15–1:50 The agent works** (Run agent on the research task. The log and green particles flow to the sites, and Live payments fill up.)
"Now a real AI agent researches a topic. When a site answers 402, it pays a few cents through Toll. Each payment is checked against my rules and by an AI judge that reads the agent's actual task."

**1:50–2:05 Owner approval** (the $0.20 bundle shows "Needs you", then click Approve)
"Anything over my threshold waits for me."

**2:05–2:30 The trap** (run the GPU benchmarks task. Red flash, BLOCKED $499, reason and signals.)
"This site hides instructions telling agents to buy a $500 verification pass. The hard limit and the AI judge both stop it, and I can see exactly why."

**2:30–2:45 Sites get paid** (click Pay out sites. Particles flow to PayPal and the batch status shows.)
"Sites earn on a ledger and get paid in one PayPal Payouts batch. Unused balance refunds back to PayPal."

**2:45–2:58 Close** (README with the one-line middleware)
"One line of code to charge agents. Plain English to control them. PayPal underneath. Toll."

# BUTTERBYTE STORE

A premium fashion e-commerce storefront built with **TanStack Start (React 19 + Vite 7)**, **Tailwind CSS v4**, and a managed **Supabase** backend (Lovable Cloud). Deployed on **Cloudflare Pages** (SSR runs on Workers).

---

## 1. Tech Stack

| Layer        | Technology                                              |
|--------------|---------------------------------------------------------|
| Framework    | TanStack Start v1 (React 19, file-based routing, SSR)   |
| Build tool   | Vite 7                                                  |
| Styling      | Tailwind CSS v4 + custom design tokens (`src/styles.css`)|
| UI Kit       | shadcn/ui + Radix primitives                            |
| State        | Zustand (cart/wishlist) + TanStack Query                |
| Backend      | Supabase (Postgres + Auth + RLS)                        |
| Server       | Nitro (SSR) on **Cloudflare Pages** (Workers runtime)    |
| Server-side  | TanStack `createServerFn`                               |
| Animations   | Framer Motion                                           |

---

## 2. Prerequisites

- **Node.js ≥ 22** and **pnpm ≥ 10** (or Bun ≥ 1.1 / npm)
- A **Supabase** project (free tier is fine) — or use Lovable Cloud
- `psql` (PostgreSQL client) for importing the SQL dump

---

## 3. Setup & Installation

```bash
# 1. Install dependencies
pnpm install           # or: bun install / npm install

# 2. Configure environment variables — create .env in project root
cp .env.example .env   # then edit with your Supabase credentials
```

### `.env` keys

| Variable                          | Where to find it                          |
|-----------------------------------|-------------------------------------------|
| `VITE_SUPABASE_URL`               | Supabase → Project Settings → API → URL   |
| `VITE_SUPABASE_PUBLISHABLE_KEY`   | Supabase → Project Settings → API → anon  |
| `VITE_SUPABASE_PROJECT_ID`        | Supabase project ref                      |
| `SUPABASE_URL`                    | Same as `VITE_SUPABASE_URL`               |
| `SUPABASE_PUBLISHABLE_KEY`        | Same as anon key                          |
| `SUPABASE_SERVICE_ROLE_KEY`       | Project Settings → API → service_role     |

### Run locally

```bash
pnpm dev               # starts Vite dev server on http://localhost:8080
```

### Production build

```bash
pnpm build
pnpm deploy            # deploy to Cloudflare Workers
# or: pnpx wrangler deploy
```

---

## 4. Database Setup

The complete database (schema + seed data) is included in `database/`:

```
database/
├── schema.sql        # tables, types, RLS policies, functions, triggers
├── seed.sql          # all products, categories, banners, CMS pages, coupons, reviews
└── csv/              # raw CSV exports of every public table
```

### Import into a NEW Supabase / Postgres database

```bash
# 1. Get your database connection URL from Supabase
#    Project Settings → Database → Connection string (URI)
export DB_URL="postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres"

# 2. Apply schema
psql "$DB_URL" -f database/schema.sql

# 3. Load seed data
psql "$DB_URL" -f database/seed.sql
```

> Alternative: run the migration files in `supabase/migrations/` instead of `schema.sql` if you prefer migration history.

### Make yourself an admin

After signing up your first user, promote them in SQL:

```sql
INSERT INTO public.user_roles (user_id, role)
VALUES ('<your-auth-user-id>', 'admin');
```

---

## 5. Managing Products & Catalog

This project does **not** ship a built-in admin UI. The catalog is managed in one of two ways:

### Option A — Supabase Studio (recommended)

Open your project in the Supabase dashboard → **Table Editor**:

| To manage…         | Edit table              | Notes                                              |
|--------------------|--------------------------|----------------------------------------------------|
| Products           | `products`              | `slug`, `name`, `mrp`, `selling_price`, `category_id`, `is_new`, `is_trending`, `is_bestseller`, `stock_qty` |
| Categories         | `categories`            | `slug`, `name`, `gender` (men/women/unisex)        |
| Product Images     | `product_images`        | One row per image; `sort_order` controls display   |
| Sizes / Inventory  | `product_variants`      | `size`, `color`, `stock_qty` per variant           |
| Pricing & Discount | `products.selling_price`, `products.mrp`, `products.discount_pct` |
| Homepage Banners   | `banners`               | `title`, `image_url`, `cta_href`, `active`         |
| Coupons            | `coupons`               | `code`, `type` (pct/flat), `value`, `min_order`    |
| Static pages       | `cms_pages`             | About, FAQ, Terms, Privacy, Shipping, Refund       |

### Option B — Direct SQL

```sql
-- Add a product
INSERT INTO public.products (slug, name, brand, mrp, selling_price, category_id, stock_qty, is_new)
VALUES ('my-new-shirt', 'My New Shirt', 'BUTTERBYTE STORE', 1999, 1499,
        (SELECT id FROM categories WHERE slug='shirts'), 25, true);

-- Attach an image
INSERT INTO public.product_images (product_id, url, sort_order)
VALUES ((SELECT id FROM products WHERE slug='my-new-shirt'),
        'https://your-cdn.com/img.jpg', 0);

-- Update price
UPDATE public.products SET selling_price = 1299 WHERE slug = 'my-new-shirt';

-- Delete product
DELETE FROM public.products WHERE slug = 'my-new-shirt';
```

> **Pricing is server-authoritative.** The checkout flow always re-reads `selling_price` from `products` before creating an order — so updating price in the DB is enough; no code change required.

---

## 6. Cart & Checkout Flow

### Cart (frontend state, persisted in `localStorage` via Zustand)

- **Add to Cart** — `cart.add(item)` (called from product pages, product cards, "View Product" pages)
- **Update quantity** — `cart.setQty(productId, size, qty)` (cart page +/- buttons)
- **Remove item** — `cart.remove(productId, size)` (× button on cart page)
- **Clear cart** — `cart.clear()` (automatic after successful order)

Route: `/cart` (`src/routes/cart.tsx`)

### Checkout

Route: `/checkout` (`src/routes/checkout.tsx`) — requires sign-in.

Flow:
1. User must be signed in (redirects to `/login?redirect=/checkout` otherwise).
2. Enter contact + shipping address.
3. **PIN code lookup** — on entering a valid 6-digit Indian PIN, `City` and `State` auto-fill via the public `https://api.postalpincode.in` API.
4. Select payment (currently **Cash on Delivery**).
5. Submit → `createOrder` server function:
   - Validates input with Zod
   - Re-fetches each item's `selling_price` from `products`
   - Recomputes subtotal, shipping (free over ₹999, else ₹79) and total **server-side** — client-supplied prices are ignored
   - Inserts into `orders` and `order_items`
6. Redirects to `/order-success?o=<order_no>`.

Order tracking (guest-friendly): `/track-order` — by order number + email/phone.

---

## 7. Authentication

- Email/password sign-up and login via Supabase Auth
- New users automatically receive the `customer` role
- Admins are promoted manually (see §4)
- Route guards: protected routes live under `/_authenticated/*`

---

## 8. Project Structure

```
src/
├── routes/                  # File-based routes (TanStack Router)
│   ├── __root.tsx           # App shell
│   ├── index.tsx            # Home page
│   ├── shop.tsx, men.tsx, women.tsx, categories.tsx
│   ├── p.$slug.tsx          # Product detail page
│   ├── c.$gender.$slug.tsx  # Category page
│   ├── cart.tsx, checkout.tsx, order-success.tsx
│   ├── track-order.tsx, wishlist.tsx, account.tsx
│   └── login.tsx, signup.tsx
├── components/              # Header, Footer, ProductCard, SearchOverlay, UI kit
├── lib/
│   ├── catalog.functions.ts # Server fns: list/get products & categories
│   ├── orders.functions.ts  # Server fns: createOrder, getMyOrders, trackOrder
│   ├── store.ts             # Zustand cart + wishlist store
│   └── use-auth.ts          # Auth hook
├── integrations/supabase/   # Auto-generated Supabase clients (DO NOT EDIT)
└── styles.css               # Tailwind v4 + design tokens

supabase/
├── migrations/              # SQL migration history
└── config.toml

database/                    # Full DB export (this delivery)
├── schema.sql
├── seed.sql
└── csv/

wrangler.toml                # Cloudflare Workers deployment config
.github/workflows/           # GitHub Actions CI/CD
└── workers-deploy.yml       # Auto-deploy on push to cf-dev
```

---

## 9. Deploying to Cloudflare Pages (with Workers SSR)

### Architecture

This project uses **TanStack Start** with **Nitro** (server engine) targeting **Cloudflare**:

- `vite build` → Nitro bundles SSR into `dist/server/index.js` (a Cloudflare Worker) + static assets into `dist/client/`
- `dist/_routes.json` → Pages routing config (all requests → Worker, static assets excluded)
- The SSR server runs as a **Cloudflare Worker** under the Pages runtime — same edge network, same performance

### Prerequisites

- **Node.js ≥ 22** and **pnpm ≥ 10** (or Bun/npm)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/): `pnpm add -g wrangler`
- A [Cloudflare](https://dash.cloudflare.com/) account
- A running [Supabase](https://supabase.com/) project (free tier works)

### Step 1: Install & Configure

```bash
pnpm install
cp .env.example .env
# Edit .env with your Supabase credentials
```

### Step 2: Deploy via Wrangler CLI

```bash
wrangler login          # authenticate with Cloudflare
pnpm build              # build → dist/
pnpm deploy             # deploys to Cloudflare Pages
```

Your app will be live at `https://butterbyte-store.pages.dev`.

### Step 3: Set Environment Variables

Set these in the Cloudflare Pages dashboard → butterbyte-store → Settings → Environment variables:

| Variable | Type | Value |
|----------|------|-------|
| `VITE_SUPABASE_PROJECT_ID` | Build | Your Supabase project ID |
| `VITE_SUPABASE_URL` | Build | `https://YOUR_ID.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Build | Your Supabase anon key |
| `NODE_ENV` | Runtime | `production` |

For secrets (like `SUPABASE_SERVICE_ROLE_KEY`):

```bash
wrangler pages secret put SUPABASE_SERVICE_ROLE_KEY
```

### Step 4: CI/CD via GitHub Actions (Optional)

Push to `cf-dev` branch to auto-deploy. Set these in your GitHub repo:

**Secrets** (Settings → Secrets and variables → Actions):
| Secret | Value |
|--------|-------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Pages:Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |

**Variables**:
| Variable | Value |
|----------|-------|
| `VITE_SUPABASE_PROJECT_ID` | Your Supabase project ID |
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase anon key |

### Step 5: Local Preview

```bash
pnpm build
pnpm dev:worker        # runs wrangler pages dev locally
```

### Step 6: Custom Domain (Optional)

In the Pages dashboard → butterbyte-store → Custom domains, bind your own domain.

---

## 10. Troubleshooting

| Symptom                                 | Fix                                                                 |
|----------------------------------------|---------------------------------------------------------------------|
| "Missing Supabase environment variable" | Check `.env` is filled and the dev server was restarted             |
| Checkout returns "Product no longer available" | The cart references a `product_id` that was deleted — clear cart    |
| PIN code lookup doesn't autofill        | The free `postalpincode.in` API may be rate-limited — fill manually |
| Build fails: `Failed to resolve import` | Run `bun install` again; ensure all files referenced exist          |
| Can't see admin features                | Make sure your `user_roles` row has `role = 'admin'`                |

---

## License

Proprietary — © BUTTERBYTE STORE

# HotCol Owner — GraphQL Backend

Apollo GraphQL API that powers the **owner mobile app**. Owners oversee a
portfolio of properties (cafés / hotels) that already live in the shared HotCol
database (same DB used by `hotcol-user` and the `hotcol` Apex dashboard).

It is **read-mostly oversight** plus a few **light actions**:

- Portfolio summary + per-property dashboards (revenue, orders, inventory value,
  staff, pending approvals, subscription/billing status).
- Manage staff credentials (create staff, reset staff password, disable/enable
  staff login) — never the property Admin/Manager.
- Submit subscription/setup payment proofs (Apex approves them in `hotcol`).

## Models

The Prisma schema **mirrors** the shared platform schema (`hotcol-user/BackEnd/prisma/schema.prisma`)
and includes the owner tables:

- `owner_account` — owner login (separate from tenant `user` and `apex_team_member`).
- `owner_property` — links an owner to the property TINs they oversee.

> Keep `prisma/schema.prisma` in sync with `hotcol-user/BackEnd/prisma/schema.prisma` (canonical base).

## Setup

```bash
cd BackEnd
npm install                 # runs prisma generate via postinstall
npm run db:push             # creates owner_account / owner_property in the shared DB
npm run seed:owner -- --user abel --password Secret123 --tins 0012345678,0098765432
npm run dev                 # http://localhost:4001/graphql
```

`.env` keys:

| Key | Purpose |
| --- | --- |
| `DATABASE_URL` | Shared HotCol database (MySQL/MariaDB) |
| `JWT_Secret` | Must match the platform secret used for tokens |
| `OWNER_JWT_EXPIRES_IN` | Owner session length (default `7d`) |
| `PORT` | Defaults to `4001` (keep distinct from other backends) |

## Auth

`ownerLogin(UserName, Password)` returns a JWT carrying `kind: "owner"`. Send it
as `Authorization: Bearer <token>` on every request. Every resolver verifies the
owner is linked to the property TIN before returning or mutating its data.

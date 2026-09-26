# The UI kit — milestone 14

Every component here comes from `project/Main.dc.html`, `project/States.dc.html` or
`project/AdminStates.dc.html`. Nothing is invented, and nothing holds a colour, radius or font of its
own — those are tokens, and `npm run check:styles` fails if one leaks.

```
npm run --prefix client dev      # then open /gallery.html
npm run ui:check                 # renders everything and asserts on it
```

## What is here

| File | Components |
|---|---|
| `Button.tsx` | `Button` (primary · secondary · text · danger, plus busy and disabled), `RoundButton`, `Spinner` |
| `Badge.tsx` | `OrderStatusBadge`, `PaymentStatusBadge`, `Chip`, `CardBadge` |
| `fields.tsx` | `TextField`, `PhoneField`, `SelectField`, `Segmented`, `Checkbox`, `Radio`, `Switch`, `QuantityStepper` |
| `OptionGroup.tsx` | `OptionGroup` — pills for *pick one*, checkboxes for *several* |
| `ProductCard.tsx` | `ProductCard` |
| `feedback.tsx` | `Alert`, `Toast`, `Skeleton`, `SkeletonRow`, `SkeletonCard` |
| `DataTable.tsx` | `DataTable` — a table at width, stacked cards below it |
| `EmptyState.tsx` | `EmptyState`, `BagIcon` |
| `StateCard.tsx` | `StateCard`, `SetupChecklist` |
| `overlays.tsx` | `BottomSheet`, `Drawer`, `ConfirmModal` |

`../states/` composes all 28 board states out of these.

## Five rules the boards set, and where they live in the code

**Order state is filled; payment state is outlined.** Two components, not one with a flag — the
distinction is what lets both read at a glance in the same row, and a prop would let a caller break
it. `Badge.tsx`.

**A status never rests on colour alone.** Every badge carries a word, a sold-out option is struck
through *and* `aria-disabled`, and the setup checklist's ticks have screen-reader text. Colour is the
second signal, never the only one.

**Errors appear next to the thing that caused them, not in a banner.** So `error` is a prop on the
field — it sets `aria-invalid`, reddens the border and is wired through `aria-describedby`. `Alert` is
for a condition about the page, not for a field. `fields.tsx`.

**One primary action per view, and a disabled button says what is missing.** The board's disabled
example reads "Choose a size", not "Continue". `Button.tsx`.

**Sheets for choices on mobile, drawers for detail on desktop, modals only to confirm something
destructive.** Three components named for their jobs; `ConfirmModal` takes a `confirmLabel` that names
the act, because a button labelled OK makes the reader re-read the question. `overlays.tsx`.

## Two things that are per-store and one that is not

`primary`, `text`, checkbox ticks, switches, the option-group selection and the product card's action
all use the **store** tokens (`bg-store-primary`, `bg-store-tint`), so the same component is the
store's own in a storefront and the platform's in the admin console.

**Status colours are not themeable** and must stay unreachable from the theme engine — §2.2 makes it a
product rule: "Paid" means the same thing in every store. `Button`'s `danger` variant uses
`status-danger-fg` for the same reason.

**Prices arrive formatted.** `packages/core`'s money formatter turns `"3500.00"` into `"3,500 RWF"`
from the currencies table; a component that formatted its own would be a second implementation of what
a price looks like.

## The vocabulary belongs to the caller

`OrderStatusBadge` takes a **label**, not a status key, and `OptionGroup` takes a **name**. Both come
from the config engine: milestone 12's `orderSteps` says food's first step is "New" where services' is
"Booked", and its attribute presets name the group. A component that mapped a key to a word would be
the branch on industry that §1.3 says means the architecture failed.

## Why there is a render gate

`tsc` proves the types. `vite build` proves the JSX compiles and the imports resolve. Neither proves a
component **runs**, and neither notices when a class name is misspelt — Tailwind just emits no rule and
the component renders unstyled.

So `client/check/render.tsx` renders the whole kit and all 28 states to static HTML through Vite's SSR
build and asserts on the output: nothing throws, the state counts match the boards, the copy is still
the boards' wording, no hex escaped the token layer, and the accessibility attributes are present. And
`check:styles` asserts that all 51 token-derived utilities the kit uses were actually emitted.

# IMS Design System

Source: the official visual reference (a clean, white corporate site with an orange accent) and, for the sign-in page, the approved sign-in screenshot. Only their **visual style** is used. Their content, navigation and unsupported sign-in methods are not.
Every page must use these tokens, utilities and components instead of raw values.

## Styling approach (React frontend)

| Layer | File | Used for |
|---|---|---|
| **Tailwind CSS v4** (primary) | `src/index.css` (via `@tailwindcss/vite`) | Layout, spacing, sizing, responsiveness, typography and colours **in JSX**. `@theme` maps the IMS tokens into Tailwind, and `@layer components` holds the design-system classes (buttons, inputs, tables, tabs, cards) |
| **SCSS: tokens** | `src/styles/_tokens.scss` | The single source of the design tokens (`--ims-*` CSS variables) |
| **SCSS: base** | `src/styles/_base.scss` (in Tailwind's `@layer base`) | Element defaults: body, headings, links, focus ring, selection |
| **SCSS: complex** | `src/styles/main.scss` | Keyframes (progress bar) and anything utilities can't express |
| **Components** | `src/components/*` | `Dialog` (native `<dialog>`), `Switch`, `Toast`, `LanguageSwitch`, `Logo`, `PreviewBanner` |

There is no UI component library. Controls are native HTML elements styled with the classes below, so they work with RTL, keyboard and screen readers out of the box.

## Character
White surfaces, generous whitespace, dark, bold, tightly-tracked headings, gray body text, hairline borders instead of shadows, and **one** warm orange accent used sparingly for the active state, the primary action and highlights.

## Colour tokens (`styles/_tokens.scss` → Tailwind `@theme`)

| Token → utility | Value | Use |
|---|---|---|
| `--ims-color-brand` → `brand` | `#E64D20` | Accent: active tab underline, focus ring, highlights (`text-brand`), the sign-in button's gradient top |
| `--ims-color-primary` → `primary` | `#C93D12` | Interactive colour: filled buttons, links, active tab text, switches. A deeper shade of the brand orange: white on it passes WCAG AA (5.05:1), while white on `#E64D20` is only 3.86:1 |
| `--ims-color-primary-hover` → `primary-hover` | `#B03510` | Hover / pressed |
| `--ims-color-primary-soft` → `primary-soft` | `#FFF1EC` | Tinted background for the selected or current item (badge, language switch) |
| `--ims-color-heading` → `heading` | `#0F1217` | Headings, strong text, toast background |
| `--ims-color-text` → `body` | `#474A4D` | Body and navigation text |
| `--ims-color-text-muted` → `muted` | `#6B6F78` | Secondary text, table headers, hints |
| `--ims-color-border` → `border` | `#E7E7EA` | Card and control borders |
| `--ims-color-divider` → `divider` | `#EEEEEE` | Header bottom line, table row lines |
| `--ims-color-surface` → `surface` | `#FFFFFF` | Page and card background |
| `--ims-color-surface-subtle` → `surface-subtle` | `#FAFAFB` | Table header, row hover |

Tailwind's default colour scales are removed (`--color-*: initial`), so only these colours (plus `white`) exist as utilities.

## Typography
- **Font:** Inter (Latin). Arabic glyphs fall back to Noto Sans Arabic. Both are loaded from Google Fonts in `index.html`. Utility: `font-sans`.
- **Scale:** `text-display` `clamp(2rem…3rem)`, `text-h1` `clamp(1.625rem…2.125rem)` weight 700 tracking −0.02em, `text-h2` 1.375rem/700, `text-h3` 1.0625rem/600, body 0.9375rem/1.6, `text-small` 0.8125rem.
- One `h1.ims-page-title` per page.

## Shape, spacing, elevation, layout
- **Radius:** `rounded-control` (10px) for app controls, `rounded-card` (16px) for cards, tables and dialogs, `rounded-lg` (8px) for the sign-in controls (to match the reference), `rounded-full` for badges and switches.
- **Spacing:** Tailwind's 4px scale (`p-4` = 16px, `gap-6` = 24px). Page side padding is `px-gutter` (fluid 16–32px).
- **Elevation:** borders first. `shadow-card` is barely visible; `shadow-raised` is for dialogs and toasts.
- **Layout:** `max-w-content` (1200px, centred), `min-h-header` (64px). Breakpoints: Tailwind defaults plus `nav` (900px), where the app header goes from two rows to one.
- **RTL/LTR:** logical utilities only (`ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `border-s`, `text-start`). Never `ml-*`, `mr-*`, `left-*` or `right-*`.

## Design-system classes (`src/index.css`, `@layer components`)

| Class | Purpose |
|---|---|
| `.ims-btn-primary` | The single primary action of a view (filled `primary`, 40px, `rounded-control`) |
| `.ims-btn-outline` | Secondary action (white, `border-border`), e.g. *Sign in* / *Sign out* in headers |
| `.ims-btn-text` | Tertiary action (text in `primary`), e.g. *Edit*, *Cancel*, language switch |
| `.ims-signin-submit` | Sign-in page submit: full width, 44px, `rounded-lg`, subtle `brand → primary` gradient (reference design in IMS colours) |
| `.ims-label`, `.ims-input`, `.ims-hint`, `.ims-error` | Label above the field; 44px bordered input (also for `<select>` and `<textarea>`); muted hint; error text. Set `aria-invalid` to show the error border |
| `.ims-page-title` | Page `h1` |
| `.ims-card` | Bordered white card, `rounded-card`, `p-6` |
| `.ims-table-card` + `.ims-table` | Card holding a full-width `<table>`: subtle header row, row lines and hover, horizontal scroll on small screens |
| `.ims-tab` | Header navigation link (`NavLink`). `aria-current="page"` shows primary text with the brand underline |
| `.ims-state` | Empty, error or loading message (dashed border, muted, centred) |
| `.ims-badge` | Small pill label (`bg-primary-soft text-primary`) |

## Recipes (reference: `features/admin`, `features/public`)

| Part | How |
|---|---|
| App header | `header.sticky.top-0.border-b.border-divider.bg-surface` › inner `mx-auto flex min-h-header max-w-content flex-wrap items-center gap-x-6 px-gutter nav:flex-nowrap`. Brand at the start, `nav` of `.ims-tab` links (scrolls horizontally on phones), `<LanguageSwitch />` and account actions at the end |
| Public header | Logo (`<Logo />`, `h-9 sm:h-12`) at the start, `<LanguageSwitch />` (+ *Sign in*) at the end |
| Page | `main.mx-auto.max-w-content.px-gutter.py-6.sm:py-12`, then a title row `mb-8 flex flex-wrap items-end justify-between gap-4` |
| Dialog | `<Dialog open title onClose>` with a `form.flex.flex-col.gap-4`, actions `flex justify-end gap-2` (text *Cancel* + primary *Save*) |
| Sign-in | Centred column `max-w-[22rem]`: `h1`, the full-width Google button, an "OR" divider (`h-px bg-divider` rules, uppercase muted label), a labelled email field, then `.ims-signin-submit`. Secondary actions are a muted line with inline `text-primary` links |
| Language switch | `<LanguageSwitch />`. Both languages show; on phones (< 640px) only the other language, so headers keep their gutters |

## Rules
1. Style with Tailwind utilities first. Use SCSS only for tokens, base styles and things utilities can't express.
2. Never hard-code colours, radii or spacing. Use the theme utilities or `var(--ims-…)`. Arbitrary values (`max-w-[520px]`) are for one-off sizes only, never for colours.
3. Use logical properties and utilities only, so RTL and LTR both work.
4. Use one primary button per view. The orange accent is for state and emphasis, not decoration.
5. New areas (trainee, employee, HR) reuse the header and page recipes.
6. Add a class to `@layer components` only for a named, repeated design-system pattern. Otherwise compose utilities.
7. Check every page at 390px width and in both Arabic and English.

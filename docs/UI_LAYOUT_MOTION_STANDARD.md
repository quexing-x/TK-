# TK Ads Automation UI Layout & Motion Standard

## Scope

This document governs the frontend visual reconstruction only. It must not change routes, page labels, API contracts, permissions, account scope, provider behavior, or business workflows.

## 1. Minimalist layout rhythm

The visual rhythm follows one principle: compact inside components, generous between sections.

### 8px grid

All spacing values must resolve to the 8px grid unless a 4px optical adjustment is required for icon or text alignment.

```css
:root {
  --space-1: 8px;
  --space-2: 16px;
  --space-3: 24px;
  --space-4: 32px;
  --space-5: 40px;
  --space-6: 48px;
  --space-8: 64px;
  --space-10: 80px;
  --space-12: 96px;
  --space-15: 120px;
}
```

### Section spacing

- Every top-level page section uses `padding-block: 80px`, `96px`, or `120px`.
- Default desktop section padding is `96px`.
- Primary overview and workflow sections may use `120px`.
- Secondary utility sections may use `80px`.
- Section-to-section spacing must never be created with arbitrary margins.
- On compact desktop and mobile layouts, section padding may reduce to `64px`, while retaining the 8px grid.

```css
.ui-section {
  padding-block: var(--space-12);
}

.ui-section--primary {
  padding-block: var(--space-15);
}

.ui-section--compact {
  padding-block: var(--space-10);
}
```

### Compact component interiors

- Dense table rows: 40px or 48px.
- Inputs and buttons: 40px or 48px.
- Card interior padding: 16px, 24px, or 32px.
- Inline control gaps: 8px.
- Form field gaps: 16px.
- Card grid gaps: 24px or 32px.
- Major section content groups: 40px, 48px, or 64px.
- Avoid nested cards when whitespace and dividers can express hierarchy.

## 2. Smooth micro-interactions

All hoverable and clickable controls use the same motion curve and duration.

```css
:where(
  button,
  a,
  [role="button"],
  .interactive,
  .nav-item,
  .action-card
) {
  transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
```

Every hover interaction must include at least one of the following:

- `transform: translateY(-2px)` for buttons, navigation items, compact action cards, and selectable rows.
- An ambient light shadow transition for panels and controls that should remain spatially fixed.

```css
.interactive:hover {
  transform: translateY(-2px);
}

.ambient-hover:hover {
  box-shadow:
    0 12px 32px rgb(44 62 90 / 0.08),
    0 2px 8px rgb(44 62 90 / 0.05);
}

.interactive:active {
  transform: translateY(0) scale(0.98);
}
```

### Accessibility and performance

- Focus-visible states must remain visible independently of hover motion.
- Disabled controls do not translate or gain ambient shadow.
- Do not animate large scrolling surfaces.
- Reduced-motion users receive immediate state changes without translation.

```css
@media (prefers-reduced-motion: reduce) {
  :where(button, a, [role="button"], .interactive, .nav-item, .action-card) {
    transition-duration: 0.01ms;
  }

  :where(button, a, [role="button"], .interactive, .nav-item, .action-card):hover,
  :where(button, a, [role="button"], .interactive, .nav-item, .action-card):active {
    transform: none;
  }
}
```

## 3. Acceptance checklist

- All layout spacing aligns to the 8px grid, except documented 4px optical adjustments.
- Every desktop section uses 80px, 96px, or 120px vertical padding.
- Component interiors remain compact and do not use section-scale whitespace.
- Every hoverable or clickable element uses the specified 0.4s cubic-bezier transition.
- Every hover state uses either a 2px lift or ambient light shadow transition.
- Reduced-motion, focus-visible, disabled, loading, empty, error, and success states remain complete.
- No existing function, route, API call, field, permission, or safety boundary is removed or extended.

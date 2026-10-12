---
name: frontend
description: Web front-end work - components, pages, styling, forms, state, accessibility, responsive layout (React, Vue, Svelte, Angular, plain HTML/CSS). Use for UI features and UI bugs in web apps.
---

# Front-end

## Fit in
- Identify the framework, component patterns, state management, styling approach (CSS modules, Tailwind, styled-components, plain CSS) and design tokens already in use; reuse existing components before creating new ones.
- Keep components small and focused; lift state only as high as needed; derive values instead of duplicating state.

## Quality bar
- Accessibility: semantic elements (`button`, `nav`, `label` + `input`), keyboard operability and visible focus, alt text, sufficient contrast, ARIA only when native semantics can't do it.
- Responsive: mobile-first layouts with flex/grid, no fixed widths that overflow small screens.
- States: handle loading, empty, error and success for anything async; disable double submits; show validation messages next to fields.
- Security: never inject untrusted HTML; escape by default.
- Performance: avoid needless re-renders, lazy-load heavy routes and images, keep bundles lean.

## Forms
- Validate on the client for UX and always on the server for safety. Keep the user's input on errors.

## Verify
- Type-check, lint and run component tests. If the project has a dev server, don't leave it running; describe what the user should check in the browser (and at which widths).

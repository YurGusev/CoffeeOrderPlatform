# `@coffee-platform/ui`

Business-neutral presentation primitives for the CoffeeOrderPlatform browser
foundation. React Aria owns semantic, keyboard and focus behavior; Tailwind CSS
v4 owns styling and tokens.

The package does not import application routes, transport, Query, Effect, API
contracts, generated DTOs, runtime packages, provider clients or browser network
APIs. Application screens and server-state composition belong to issue #9.

## Public surface

The public surface is intentionally limited to `Button`, `Link`, `Dialog`,
`Field`, `Input`, `Alert`, `Badge`, `Loading`, `Empty` and package-owned inline
icons.

- `Button`: `variant` is `primary | secondary | danger | quiet`; `size` is
  `compact | default | touch`; `isPending` exposes the React Aria pending state;
  `ref` targets the native button.
- `Field`: `isInvalid` is independent from `errorMessage`; `ref` targets the
  native input and is the hook for first-invalid focus.
- `Input`: package-owned React Aria input wrapper with the same native input ref
  contract.
- `Dialog`: supports controlled (`isOpen`) and uncontrolled (`defaultOpen`)
  usage. Outside dismissal is opt-in through `isDismissable`; Escape can be
  disabled with `isKeyboardDismissDisabled`. `onRequestClose` may reject
  `escape`, `outside` or explicit `action` closes while data is dirty or
  pending. `initialFocusRef` and `returnFocusRef` make focus policy explicit;
  the modal surface is bounded and scrollable on small viewports.

## Browser and package builds

From the repository root:

```sh
pnpm --filter @coffee-platform/ui build
pnpm web:build
pnpm dev:browser
```

`dev:browser` starts the Vite browser shell. The existing Node entry remains
`apps/web/src/main.ts` and is built separately to `apps/web/dist/main.js`.
The browser bundle is emitted to `apps/web/dist/browser`; generated `dist`
artifacts are local verification outputs and are not committed.

The package stylesheet is exported as `@coffee-platform/ui/styles.css`. IBM
Plex Sans is self-hosted from the package font assets; no remote font or
network request is required by the foundation.

## Provenance

The selected shadcn/ui React Aria source snapshots and local adaptations are
recorded in `provenance/shadcn/` and `THIRD_PARTY_NOTICES.md`. That directory
is provenance only and is not imported by the runtime build.

## TypeScript 7 compatibility exception

The exact `react-aria-components@1.21.1` dependency currently requires the
narrow, type-only `@react-types/shared@3.36.1` declaration patch recorded in
`THIRD_PARTY_NOTICES.md` and `ADR-0027`. This is an explicit #137 exception for
six optional ARIA/DOM properties only: it does not patch runtime framework code,
does not permit `skipLibCheck`, and must be removed when upstream declarations
become compatible with the pinned TypeScript 7 graph.

# Third-party notices

## IBM Plex Sans

IBM Plex Sans web font files are copied from the official IBM Plex repository at
revision `bf260093582f04622aacc1e9f9ca604d7ccd0c42`:

<https://github.com/IBM/plex/tree/bf260093582f04622aacc1e9f9ca604d7ccd0c42/packages/plex-sans/fonts/complete/woff2>

| File | SHA-256 |
| --- | --- |
| `IBMPlexSans-Regular.woff2` | `ba711a3085ff9f27440b6b9c4550cfc47c97bf36591d5da958b975bb3add8c1a` |
| `IBMPlexSans-Medium.woff2` | `5660f8a658f8bb50dbc005232f885eadffd2bc1c235c4f6fbb63469d1f9cde6d` |
| `IBMPlexSans-SemiBold.woff2` | `f78048030eab62e860efa39a0df79e2e5581bf122eb95b9bc42c0b8a4988d205` |
| `license.txt` | `91c25c350d3cac39da2736d74f7ba37ef648f5237a4e330a240615bc8d8c4360` |

The font files are distributed under the SIL Open Font License 1.1. The complete
license text is retained in `src/styles/fonts/license.txt`.

## shadcn/ui React Aria registry

The React Aria-compatible registry was copied at the immutable source revision:

<https://github.com/shadcn-ui/ui/tree/3ba91b1cc83e1bbe4ab35a422ff2a694849c5048>

Selected source files are preserved in `provenance/shadcn/aria/` and adapted in
the production components. The upstream paths and source hashes are:

| Local snapshot | Upstream path | SHA-256 |
| --- | --- | --- |
| `provenance/shadcn/aria/button.tsx` | `apps/v4/registry/bases/aria/ui/button.tsx` | `8bcff6f70522e6e6cb0ff67f050830ea1a93596403d2d9b035f3b543c7a42e2c` |
| `provenance/shadcn/aria/dialog.tsx` | `apps/v4/registry/bases/aria/ui/dialog.tsx` | `ff8a8e6b372e7eb06c931975d8ac1ea59d9271051ac178a62c95f6acae20bb35` |
| `provenance/shadcn/aria/field.tsx` | `apps/v4/registry/bases/aria/ui/field.tsx` | `1019104c41eaef8ffae109e2ece95be87a7a637e3a9bac049d7a9fb54bfb7275` |
| `provenance/shadcn/aria/input.tsx` | `apps/v4/registry/bases/aria/ui/input.tsx` | `b9596748b7238b5605f558474e9d50afc1535c5832c57134055e4bbde5fa804f` |

Local adaptations: `Button` keeps the React Aria primitive and `cn` composition
but maps variants/sizes to the accepted CoffeeOrderPlatform API and exact target
tokens; `Dialog` adds controlled/uncontrolled state, dirty/pending close guards,
initial/return focus refs and bounded scrolling; `Field` keeps native
`isInvalid` and input-ref semantics; `Input` is a package-owned native-input
wrapper. CVA, shadcn CLI and registry runtime imports remain excluded.

The upstream registry is MIT licensed:

Copyright (c) 2023-present shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## React Spectrum type compatibility patch

The pinned `react-aria-components@1.21.1` transitively consumes
`@react-types/shared@3.36.1` from React Spectrum revision
`5ecb3333001313e83898cd07644227897e3bae1f5`:

<https://github.com/adobe/react-spectrum/tree/5ecb3333001313e83898cd07644227897e3bae1f5/packages/@react-types/shared>

The package is Apache-2.0 licensed. The repository carries one pnpm patch at
`patches/@react-types__shared@3.36.1.patch` that makes the six ARIA/DOM optional
properties explicit `string | undefined`, which is required by the pinned
TypeScript 7 `exactOptionalPropertyTypes` gate. This is the explicit, narrow
#137 compatibility exception recorded in ADR-0027; it changes no runtime
framework code and is not a general framework-patching allowance. Patch SHA-256:
`6d2be2fb416b65bc3a4aafe22d74cefc9b9b51cbb486031b96d70cd089a5bcfd`.

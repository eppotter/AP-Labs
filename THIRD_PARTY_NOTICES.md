# Third-party notices

This template bundles two upstream skill sets as pinned copies (see `AGENTS.md`, Skills). Both are under the MIT License, whose notice must go with every copy, including each client fork.

| Bundled copy | Upstream | Version | Licence |
|---|---|---|---|
| `_bmad/` and the `bmad-*` skills in `.agents/skills/` | BMAD-METHOD, github.com/bmad-code-org/BMAD-METHOD | 6.12.4 | MIT, below |
| `.agents/p3-stack/` and its skills in `.agents/skills/` | p3-stack | pinned copy | MIT, in `.agents/p3-stack/LICENSE` |

## npm dependencies with their own notice terms

These are not copied into this repo: `npm ci` installs them from the npm registry, at the versions pinned in `package.json` and `package-lock.json`, and the container image carries them in `node_modules/`, each with its own licence file. They are listed here because their terms ask for more than the MIT and Apache-2.0 packages do.

| Package | Upstream | Version | Licence | Used by |
|---|---|---|---|---|
| `@resvg/resvg-js` and its per-platform binary packages (`@resvg/resvg-js-<platform>`, of which the image installs `@resvg/resvg-js-linux-x64-gnu`) | resvg-js, github.com/yisibl/resvg-js | 2.6.2 | MPL-2.0 | `kit/runtime/routing-map/png.js` only: the route map's SVG to PNG (Story 15.3) |

**MPL-2.0 terms in short.** We use resvg-js unmodified, as a library. The MPL covers its own files, not ours. Anyone who receives it (a client fork, the container image) receives it under the MPL-2.0, with its licence text in `node_modules/@resvg/resvg-js/LICENSE` (the binary packages declare MPL-2.0 in their `package.json` and carry no copy of their own), and its source is public at github.com/yisibl/resvg-js and in the npm registry. If we ever change a resvg-js file, the changed file stays under the MPL-2.0 and its source must be made available.

## BMAD-METHOD

MIT License

Copyright (c) 2025 BMad Code, LLC

This project incorporates contributions from the open source community.
See [CONTRIBUTORS.md](CONTRIBUTORS.md) for contributor attribution.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

TRADEMARK NOTICE:
BMad™, BMad Method™, and BMad Core™ are trademarks of BMad Code, LLC, covering all
casings and variations (including BMAD, bmad, BMadMethod, BMAD-METHOD, etc.). The use of
these trademarks in this software does not grant any rights to use the trademarks
for any other purpose. See [TRADEMARK.md](TRADEMARK.md) for detailed guidelines.

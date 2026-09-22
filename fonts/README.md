# fonts/

Self-hosted font files, copied from the sibling project ponbio (they were taken from Google Fonts there). They are
not brand-specific: ponbio used them because its source site did, so the Ponchem design author is free to keep
them, use a subset, or replace them. Whatever is chosen, nothing loads from Google Fonts at runtime (SPEC.md, 2.8).

| family | files | kind | weights in the file | license |
|---|---|---|---|---|
| Albert Sans | albert-sans-latin.woff2, albert-sans-latin-ext.woff2 | variable (fvar, gvar, avar tables present) | 300 to 700 declared in fonts.css | OFL-albert-sans.txt |
| Anybody | anybody-latin.woff2, anybody-latin-ext.woff2 | variable (fvar, gvar, avar tables present), width 100% | 400 to 800 declared in fonts.css | OFL-anybody.txt |
| Space Mono | space-mono-latin-400.woff2, space-mono-latin-ext-400.woff2, space-mono-latin-700.woff2, space-mono-latin-ext-700.woff2 | static | 400 and 700 | OFL-space-mono.txt |

Each family is split into a `latin` file and a `latin-ext` file with `unicode-range`, so a page that only uses
ASCII downloads one file per family. All three are under the SIL Open Font License 1.1; the license texts were
fetched from github.com/google/fonts (ofl/albertsans, ofl/anybody, ofl/spacemono) on 2026-09-22.

`fonts.css` carries the @font-face rules and is linked from `partials/head.html` as `/fonts/fonts.css`. A page
uses them with `font-family: 'Albert Sans'`, `'Anybody'` or `'Space Mono'`.

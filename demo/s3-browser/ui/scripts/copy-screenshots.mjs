#!/usr/bin/env node
// Sync screenshots from the canonical home (docs/screenshots/) into the UI's
// public/screenshots/ so Vite copies them to dist/ and rust-embed bakes them
// into the binary — served at /_/screenshots/* for the embedded docs viewer.
//
// Why: docs/screenshots/ is the SINGLE source of truth (also consumed by the
// marketing site via marketing/scripts/copy-screenshots.mjs). The product docs
// (docs/product/*.md) reference /_/screenshots/<name>.jpg; if a screenshot
// exists in docs/screenshots/ but not here, the product renders a broken image.
// Mirroring on every build keeps the two in lockstep with zero check-in churn
// (public/screenshots/ is gitignored).
//
// Invoked automatically by `npm run build` via the prebuild hook.

import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(here, '..');
// scripts/ → ui/ → s3-browser/ → demo/ → repo root
const repoRoot = join(uiRoot, '..', '..', '..');
const src = join(repoRoot, 'docs', 'screenshots');
const dst = join(uiRoot, 'public', 'screenshots');

const IMG = /\.(jpe?g|png|webp|svg)$/i;

// Start from a clean slate so a screenshot deleted upstream doesn't linger.
await rm(dst, { recursive: true, force: true });
await mkdir(dst, { recursive: true });

const entries = await readdir(src, { withFileTypes: true });
const files = entries.filter((e) => e.isFile() && IMG.test(e.name));

if (files.length === 0) {
    console.warn(`warn: no screenshots found in ${src}`);
} else {
    await Promise.all(
        files.map((f) => cp(join(src, f.name), join(dst, f.name), { force: true })),
    );
    console.log(
        `copied ${files.length} screenshots from docs/screenshots/ → ui/public/screenshots/`,
    );
}

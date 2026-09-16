# Monorepo of independent Bundles

DSH installs a plugin as a Bundle: one npm package, one `dsh.bundle.patch` layer. Putting several Plugins in one package would force them on or off together, and a single Patch cannot honestly describe unrelated contributions. Separate git repos would scatter the same tsconfig, tsdown, and naming rules.

This repo is a pnpm workspace of Bundles under `plugins/<name>/`. Packages do not depend on each other until a second Plugin actually shares code. The install unit stays one Bundle; the maintenance unit stays one checkout.

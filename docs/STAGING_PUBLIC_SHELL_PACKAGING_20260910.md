# Staging public-shell packaging repair — 2026-09-10

Run 34449849684 built Atmos master `4ec0b8baa1d33ca56d50e5e9797eca74293bd19b` and passed application/browser gates, but refused before publishing: 3,643 shell files + 1,365 retained ground files + one receipt = 5,009 ordinary files. `thumbs/wetbulb.webp` merely happened to cross the unchanged 5,000-file limit.

For the exact nonpromotable staging-account profile only, omit deployment copies of 60 explicitly reviewed legacy thumbnail JPGs before build/receipt creation. Keep source files. All current layer menu, sheet, pill and native runtime consumers use WebP; repo search found JPG mentions only in comments/generation tooling. Require a regular-file, valid-envelope WebP counterpart for each omitted JPG. Unknown filenames remain, even if paired. Other profiles, including production-compatible, retain their existing inventory.

Actual source-copy audit: 60 removed files / 3,252,026 bytes; 4,687 retained source assets byte-identical. Pillow decoded all 60 WebPs. Expected qualified artifact count is 4,949 before any independently added source changes. Keep the 5,000-file/96-MiB limits, private-path checks, receipt hashes, encryption, rollback fuse, account and browser qualification unchanged. No weather data, ground/overview tile, source fixture or Worker configuration is removed or modified.

Do not blanket-drop `data-fixtures`: production radiosonde code still has a runtime-to-fixture fallback. Its product/data-honesty implications require a separate review, not an unannounced packaging change.

Regression gate: `node --test tests/ui-*.mjs`. Production configuration/publication is not authorized by this repair. Live staging thumbnail/menu/search/account verification still follows the guarded deployment.

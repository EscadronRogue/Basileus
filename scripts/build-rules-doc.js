// scripts/build-rules-doc.js - writes docs/rules.md from ui/rules.js.
//
// The rules live in one place (ui/rules.js); run `npm run build:rules-doc`
// after editing them. scripts/rulesDoc.test.js fails when the doc is stale.
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderRulesMarkdown } from '../ui/rules.js';

export const RULES_DOC_PATH = 'docs/rules.md';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(resolve(projectRoot, RULES_DOC_PATH), renderRulesMarkdown());
  console.log(`Wrote ${RULES_DOC_PATH}`);
}

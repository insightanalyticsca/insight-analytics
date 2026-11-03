#!/usr/bin/env node
/**
 * seo-rollback.mjs — Roll back an adaptive SEO rewrite.
 *
 * Usage:
 *   node seo-rollback.mjs <path>              # roll back most recent rewrite for path
 *   node seo-rollback.mjs <path> --steps N    # roll back N most recent rewrites for path
 *   node seo-rollback.mjs <path> --list       # show all variants for path (no changes)
 *
 * Example:
 *   node seo-rollback.mjs insights/agentic-ai-in-strategic-sourcing-hype-or-hero.html
 *
 * Pulls the previous title/description from seo-changelog.json, applies it
 * back to the file, and appends a new changelog entry noting the rollback.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = process.cwd();
const STATE_PATH = join(REPO_ROOT, 'seo-state.json');
const CHANGELOG_PATH = join(REPO_ROOT, 'seo-changelog.json');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node seo-rollback.mjs <path> [--steps N] [--list]');
  process.exit(1);
}

const targetPath = args[0];
const flagIdx = args.findIndex(a => a === '--steps' || a === '--list');
const listMode = args.includes('--list');
let steps = 1;
const stepsIdx = args.indexOf('--steps');
if (stepsIdx >= 0 && args[stepsIdx + 1]) {
  steps = parseInt(args[stepsIdx + 1], 10) || 1;
}

const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
const changelog = JSON.parse(readFileSync(CHANGELOG_PATH, 'utf-8'));

// Find all rewrites for this path (in chronological order)
const rewrites = changelog.entries.filter(e => e.relPath === targetPath && e.action === 'rewrite-seo');

if (listMode) {
  console.log(`\nVariant history for ${targetPath}:`);
  console.log(`  ${rewrites.length} rewrites found:\n`);
  rewrites.forEach((r, i) => {
    console.log(`  [${i+1}] ${r.date}`);
    console.log(`      trend: "${r.targetTerm}" (vol ${r.termVolume})`);
    console.log(`      title:    ${r.titleAfter.slice(0, 70)}...`);
    console.log(`      desc:     ${r.descAfter.slice(0, 70)}...`);
    console.log(`      reason:   ${r.reason}`);
    console.log();
  });
  if (rewrites.length === 0) {
    console.log('  No rewrites found for this path.');
  }
  process.exit(0);
}

if (rewrites.length === 0) {
  console.error(`No rewrites found for ${targetPath}. Nothing to roll back.`);
  process.exit(1);
}

if (steps > rewrites.length) {
  console.warn(`Requested ${steps} steps back but only ${rewrites.length} rewrites exist. Using ${rewrites.length}.`);
  steps = rewrites.length;
}

// Roll back N steps — find the variant that existed N rewrites ago
// If we want to roll back 1 step, we restore the titleBefore/descBefore of the most recent rewrite.
const targetRewrite = rewrites[rewrites.length - steps];
const restoreTitle = targetRewrite.titleBefore;
const restoreDesc = targetRewrite.descBefore;

console.log(`\nRolling back ${targetPath} ${steps} step(s)...`);
console.log(`Restoring to the state from BEFORE ${targetRewrite.date}`);
console.log(`  trend at that rewrite: "${targetRewrite.targetTerm}"`);
console.log(`  title to restore:    ${restoreTitle.slice(0, 70)}...`);
console.log(`  desc to restore:     ${restoreDesc.slice(0, 70)}...`);

// Read the file
const fullPath = join(REPO_ROOT, targetPath);
let html = readFileSync(fullPath, 'utf-8');

// Replace title + description with the rolled-back versions
html = html.replace(
  /<title[^>]*>([\s\S]*?)<\/title>/i,
  `<title>${restoreTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</title>`
);
html = html.replace(
  /<meta\s+name=["']description["']\s+content=["']([^"']*)["']\s*\/?>/i,
  `<meta name="description" content="${restoreDesc.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}">`
);
// Also rollback og:title + og:description
html = html.replace(
  /<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']\s*\/?>/i,
  `<meta property="og:title" content="${restoreTitle.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}">`
);
html = html.replace(
  /<meta\s+property=["']og:description["']\s+content=["']([^"']*)["']\s*\/?>/i,
  `<meta property="og:description" content="${restoreDesc.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}">`
);

writeFileSync(fullPath, html);
console.log(`✓ Wrote rolled-back HTML to ${targetPath}`);

// Update state — set currentTerm to the one we rolled back to, update lastRewriteDate
const prevVariant = state.urls[targetPath]?.variantHistory?.[state.urls[targetPath].variantHistory.length - steps - 1];
if (prevVariant) {
  state.urls[targetPath].currentTargetTerm = prevVariant.targetTerm;
  state.urls[targetPath].currentTermVolume = prevVariant.termVolume;
  state.urls[targetPath].lastRewriteDate = new Date().toISOString();
  state.urls[targetPath].variantHistory.push({
    date: new Date().toISOString(),
    targetTerm: prevVariant.targetTerm,
    termVolume: prevVariant.termVolume,
    titleBefore: targetRewrite.titleAfter,
    titleAfter: prevVariant.titleAfter,
    descBefore: targetRewrite.descAfter,
    descAfter: prevVariant.descAfter,
    reason: `rollback ${steps} step(s) — restored to variant from ${prevVariant.date}`
  });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`✓ Updated seo-state.json`);
}

// Append rollback to changelog
changelog.entries.push({
  date: new Date().toISOString(),
  relPath: targetPath,
  action: 'rollback',
  stepsBack: steps,
  restoredTitle: restoreTitle,
  restoredDesc: restoreDesc,
  reason: `manual rollback — restored to variant from ${targetRewrite.date}`
});
writeFileSync(CHANGELOG_PATH, JSON.stringify(changelog, null, 2));
console.log(`✓ Appended rollback entry to seo-changelog.json`);
console.log(`\nDone. Commit + push to deploy.`);

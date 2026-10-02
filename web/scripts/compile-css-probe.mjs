// Compile app/globals.css with the v4 engine and print utility rules for
// theme-token verification (before/after the @config -> @theme migration).
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';

const css = readFileSync('app/globals.css', 'utf8');
const result = await postcss([tailwindcss()]).process(css, {
  from: 'app/globals.css',
});

const probes = [
  '.bg-background {',
  '.text-muted-foreground {',
  '.border-border {',
  '.ring-ring {',
  '.bg-primary {',
  '.text-destructive-foreground {',
  '.rounded-lg {',
  '.rounded-md {',
  '.rounded-sm {',
  '.rounded-xl {',
  '.animate-accordion-down {',
  '.animate-accordion-up {',
  '.animate-collapsible-down {',
  '.from-amber-50 {',
  '.to-teal-100\\/50 {',
  'amber-800\\/30:is(.dark',
  'amber-950\\/40:is(.dark',
  'emerald-500\\/20:is(.dark',
  'text-emerald-400:is(.dark',
  'hover\\:bg-blue-500\\/10',
  '.text-emerald-600 {',
  '.animate-in {',
  '.zoom-in-95',
  '.bg-gray-900\\/90 {',
];

const out = result.css;
for (const probe of probes) {
  const idx = out.indexOf(probe);
  if (idx === -1) {
    console.log(`MISSING ${probe}`);
    continue;
  }
  console.log('### ' + probe);
  console.log(out.slice(idx, out.indexOf('}', idx) + 1));
}
console.log('### TOTAL BYTES', out.length);

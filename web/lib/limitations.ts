// Limitations text is SOURCED FROM THE README at build time, not duplicated here.
//
// The README is the canonical record of what this dataset cannot support. A copy
// in the frontend would drift, and the version a visitor reads would quietly stop
// matching the version the project actually believes. So the page reads the file.
//
// The coupling is explicit: README.md carries <!-- web:limitations:start --> /
// <!-- web:limitations:end --> markers. If someone removes them the build throws
// rather than silently rendering an empty section.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const START = '<!-- web:limitations:start -->';
const END = '<!-- web:limitations:end -->';

/** Vercel checks out the whole repo, so ../README.md resolves with root dir web/. */
const CANDIDATES = ['../README.md', 'README.md', '../../README.md'];

export function readLimitations(): string[] {
  let raw: string | null = null;
  for (const rel of CANDIDATES) {
    try {
      raw = readFileSync(join(process.cwd(), rel), 'utf8');
      break;
    } catch {
      /* try the next candidate */
    }
  }
  if (raw === null) throw new Error('README.md not found; limitations cannot be sourced');

  const from = raw.indexOf(START);
  const to = raw.indexOf(END);
  if (from < 0 || to < 0) {
    throw new Error('README.md limitations markers missing; refusing to render an empty section');
  }

  // Bullets are "- **Lead.** body", possibly wrapped over several lines.
  return raw
    .slice(from + START.length, to)
    .split(/\n(?=- )/)
    .map((b) => b.replace(/^- /, '').replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
}

/** Split "**Lead.** rest" into a bolded lead and the remainder. */
export function splitBullet(bullet: string): { lead: string; rest: string } {
  const m = bullet.match(/^\*\*(.+?)\*\*\s*(.*)$/s);
  if (!m) return { lead: '', rest: bullet.replace(/\*\*/g, '') };
  return { lead: m[1], rest: m[2].replace(/\*\*/g, '').replace(/`/g, '') };
}

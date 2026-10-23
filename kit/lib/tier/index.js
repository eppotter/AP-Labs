'use strict';

// Blast radius (PR-01): the tier of a change is computed from the paths it
// touches, never declared. A declared tier is a proposal; max(declared,
// computed) wins, and a declaration below the computed floor is a finding.
//
// Floor of one path, first match wins:
//   T3  .aplabs/**, hard-coded: the profile can never lower its own floor
//   T3  profile tiers.T3
//   T2  profile tiers.T2
//   T1  profile tiers.T1
//   T1  agent instruction files (CLAUDE.md, AGENTS.md, SKILL.md, .claude/**):
//       they steer the builder, so they are never inert
//   T0  profile inert
//   T1  anything else: code never floors at T0
// Floor of a change = the highest tier of any path. T0 only when EVERY path is inert.
//
// Fail high, never low:
//   - Rules that RAISE a tier match case-insensitively (Billing/x.js on a
//     case-insensitive filesystem is billing/x.js). The inert rule, the only
//     one that LOWERS a tier, matches exact case.
//   - Paths are normalised first, so docs/../billing/x.js is billing/x.js.
//     A path that leaves the repo root, or is absolute, floors at T3.
//   - No paths at all is an error, never T0 (an upstream diff that failed
//     must not read as "nothing changed").
//
// Harvested from the archived repo's tier-floor.js: globToRegExp, the
// tierOf / tierFloor / maxTier semantics, exit 2 on no paths. The four literal
// path arrays now come from the profile.

const path = require('path');

const TIERS = ['T0', 'T1', 'T2', 'T3'];
const ORDER = { T0: 0, T1: 1, T2: 2, T3: 3 };
const ENGINE_T3 = ['.aplabs/**'];

function globToRegExp(glob, flags = '') {
  // Minimal glob: `**` = any depth (incl. none), `*` = within one segment. Anchored.
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', flags);
}

function isInstructionFile(p) {
  const segs = p.split('/');
  return /^(claude(\.local)?|agents|skill)\.md$/i.test(segs[segs.length - 1]) || segs.some((s) => /^\.claude$/i.test(s));
}

// Compiled rules, cached per (frozen) profile object.
const compiled = new WeakMap();

function rulesOf(profile) {
  let rules = compiled.get(profile);
  if (!rules) {
    const raise = (globs) => (globs || []).map((g) => globToRegExp(g, 'i'));
    rules = {
      engineT3: raise(ENGINE_T3),
      T3: raise(profile.tiers.T3),
      T2: raise(profile.tiers.T2),
      T1: raise(profile.tiers.T1),
      inert: profile.inert.map((g) => globToRegExp(g)),
    };
    compiled.set(profile, rules);
  }
  return rules;
}

// Repo-relative POSIX path, or null when it is absolute or leaves the repo.
function normalise(p) {
  const s = String(p).trim().replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[A-Za-z]:\//.test(s)) return null;
  const n = path.posix.normalize(s);
  if (n === '..' || n.startsWith('../')) return null;
  return n === '.' ? null : n;
}

const any = (p, rxs) => rxs.some((r) => r.test(p));

/** Tier of ONE path. */
function tierOf(profile, filePath) {
  const p = normalise(filePath);
  if (p === null) return 'T3';
  const r = rulesOf(profile);
  if (any(p, r.engineT3) || any(p, r.T3)) return 'T3';
  if (any(p, r.T2)) return 'T2';
  if (any(p, r.T1) || isInstructionFile(p)) return 'T1';
  if (any(p, r.inert)) return 'T0';
  return 'T1';
}

/** Floor of a change: the highest tier of any path. Throws on an empty list. */
function tierFloor(profile, paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('tierFloor: no paths, cannot compute a floor');
  let best = 'T0';
  for (const p of paths) {
    const t = tierOf(profile, p);
    if (ORDER[t] > ORDER[best]) best = t;
    if (best === 'T3') break;
  }
  return best;
}

/** Highest of two tiers. An unknown value counts as nothing. */
function maxTier(a, b) {
  const A = ORDER[a] ?? -1;
  const B = ORDER[b] ?? -1;
  if (A < 0 && B < 0) return 'T0';
  return A >= B ? a : b;
}

/**
 * Resolve a change: { floor, tier, belowFloor }. `tier` = max(declared, floor).
 * belowFloor is true when a tier was declared and it is lower than the floor (a finding).
 */
function resolveTier(profile, paths, declared) {
  const floor = tierFloor(profile, paths);
  const valid = TIERS.includes(declared);
  return {
    floor,
    tier: valid ? maxTier(declared, floor) : floor,
    belowFloor: valid && ORDER[declared] < ORDER[floor],
  };
}

module.exports = { tierOf, tierFloor, maxTier, resolveTier, globToRegExp, ENGINE_T3, TIERS };

// CLI: node kit/lib/tier [--declared T1] path…   (or paths on stdin, one per line)
// Prints the JSON result. Exit 0 ok, 1 declared below floor, 2 usage / no paths / bad profile.
if (require.main === module) {
  const { loadProfile } = require('../profile');
  const fail = (msg) => { process.stderr.write(`tier: ${msg}\n`); process.exit(2); };
  const args = process.argv.slice(2);
  let declared;
  const di = args.indexOf('--declared');
  if (di >= 0) {
    declared = args[di + 1];
    if (!TIERS.includes(declared)) fail(`--declared must be one of ${TIERS.join(', ')}`);
    args.splice(di, 2);
  }
  const run = (raw) => {
    const paths = raw.map((s) => s.trim()).filter(Boolean);
    if (!paths.length) fail('no paths received, cannot compute a floor (did the upstream diff fail?)');
    let profile;
    try { profile = loadProfile(); } catch (e) { fail(e.message); }
    const result = resolveTier(profile, paths, declared);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(result.belowFloor ? 1 : 0);
  };
  if (args.length) run(args);
  else {
    let buf = '';
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => run(buf.split('\n')));
  }
}

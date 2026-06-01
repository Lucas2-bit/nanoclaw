// This is a NARROW AWARENESS BACKSTOP, not the primary safety guarantee.
// The human (Lucas) is the primary check. Do not over-rely on or
// over-engineer this filter (Lucas, 2026-05-31).

/**
 * Canonical allergen prose for system-prompt injection.
 *
 * Verbatim facts; only the headers/spacing are formatted for readability.
 */
export const SAFETY_BLOCK = `# SAFETY-CRITICAL — CHILD ALLERGENS (HARD EXCLUDE, ALL CONTEXTS: food, recipe, restaurant, childcare, medication/pharmacy). NO EXCEPTIONS.

## Oliver (non-verbal, autistic; respiratory condition / twice-daily inhaler)
- egg (exclude) ; all nuts — tree nuts AND peanuts (exclude) ; coconut (moderate).
- MEDICATIONS to exclude (anaphylaxis): erythromycin, amoxicillin (and amoxicillin-containing e.g. Augmentin/co-amoxiclav).

## Alexander (non-verbal, autistic; ADHD; G6PD deficiency)
- sesame (anaphylaxis) ; celery (moderate).
- G6PD: NO fava/broad beans. Flag hemolysis-risk drugs: primaquine, tafenoquine, sulfonamides/co-trimoxazole (Bactrim/Septrin), sulfasalazine, dapsone, nitrofurantoin (Macrobid), quinolones (ciprofloxacin/levofloxacin/etc), methylene blue, rasburicase, phenazopyridine. Authoritative: g6pd.org.

If ANY ingredient/medicine is uncertain, FLAG and ask — never assume safe.`;

export type AllergenSeverity = 'anaphylaxis' | 'moderate' | 'g6pd';
export type AllergenChild = 'oliver' | 'alexander';

export interface AllergenEntry {
  canonical: string;
  severity: AllergenSeverity;
  child: AllergenChild;
  terms: string[];
}

export const ALLERGEN_TERMS: AllergenEntry[] = [
  {
    canonical: 'egg',
    severity: 'anaphylaxis',
    child: 'oliver',
    terms: [
      'egg',
      'eggs',
      'mayonnaise',
      'mayo',
      'aioli',
      'meringue',
      'custard',
      'hollandaise',
      'albumen',
      'egg wash',
      'frittata',
      'quiche',
    ],
  },
  {
    canonical: 'nuts',
    severity: 'anaphylaxis',
    child: 'oliver',
    terms: [
      'nut',
      'nuts',
      'almond',
      'cashew',
      'walnut',
      'hazelnut',
      'filbert',
      'pecan',
      'pistachio',
      'macadamia',
      'brazil nut',
      'pine nut',
      'peanut',
      'groundnut',
      'monkey nut',
      'marzipan',
      'praline',
      'nougat',
      'frangipane',
      'gianduja',
      'nutella',
      'pesto',
      'satay',
    ],
  },
  {
    canonical: 'coconut',
    severity: 'moderate',
    child: 'oliver',
    terms: ['coconut'],
  },
  {
    canonical: 'erythromycin',
    severity: 'anaphylaxis',
    child: 'oliver',
    terms: [
      'erythromycin',
      'erythrocin',
      'ery-tab',
      'ees',
      'erythroped',
      'zineryt',
    ],
  },
  {
    canonical: 'amoxicillin',
    severity: 'anaphylaxis',
    child: 'oliver',
    terms: [
      'amoxicillin',
      'amoxil',
      'augmentin',
      'co-amoxiclav',
      'clavulanate',
      'trimox',
      'moxatag',
    ],
  },
  {
    canonical: 'sesame',
    severity: 'anaphylaxis',
    child: 'alexander',
    terms: [
      'sesame',
      'tahini',
      'hummus',
      'houmous',
      'halva',
      'gomashio',
      'gomasio',
      "za'atar",
      'zaatar',
      'benne',
    ],
  },
  {
    canonical: 'celery',
    severity: 'moderate',
    child: 'alexander',
    terms: ['celery', 'celeriac'],
  },
  {
    canonical: 'fava',
    severity: 'g6pd',
    child: 'alexander',
    terms: ['fava bean', 'fava beans', 'broad bean', 'broad beans', 'favism'],
  },
  {
    canonical: 'g6pd_drugs',
    severity: 'g6pd',
    child: 'alexander',
    terms: [
      'primaquine',
      'tafenoquine',
      'krintafel',
      'kozenis',
      'arakoda',
      'sulfamethoxazole',
      'co-trimoxazole',
      'cotrimoxazole',
      'bactrim',
      'septrin',
      'septra',
      'sulfasalazine',
      'dapsone',
      'nitrofurantoin',
      'macrobid',
      'macrodantin',
      'furadantin',
      'ciprofloxacin',
      'cipro',
      'ciproxin',
      'nalidixic',
      'norfloxacin',
      'ofloxacin',
      'moxifloxacin',
      'avelox',
      'levofloxacin',
      'levaquin',
      'tavanic',
      'methylene blue',
      'rasburicase',
      'phenazopyridine',
    ],
  },
];

export const FALSE_POSITIVE_ALLOWLIST: string[] = [
  'eggplant',
  'aubergine',
  'egg-free',
  'egg free',
  'eggshell',
  'nutmeg',
  'butternut',
  'doughnut',
  'donut',
  'coconut',
];

/**
 * Lowercase, replace hyphens with spaces, strip punctuation to spaces,
 * collapse whitespace.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Bare single-token terms whose matches need allowlist filtering so that
// "eggplant", "nutmeg", "butternut", "egg-free", etc. don't trigger.
const BARE_TERMS = new Set(['egg', 'eggs', 'nut', 'nuts']);

/**
 * Word-boundary match each term against normalized text. Dedup by canonical.
 * Multi-word terms (e.g. "pine nut", "broad bean", "egg wash") match as
 * phrases. Bare egg/nut matches are checked against an allowlist-scrubbed
 * version of the text so eggplant/nutmeg/butternut/coconut/egg-free do not
 * create false positives.
 */
export function findAllergens(
  text: string,
): { canonical: string; term: string }[] {
  const n = normalize(text);
  if (!n) return [];

  const allowSorted = [...FALSE_POSITIVE_ALLOWLIST]
    .map((a) => normalize(a))
    .filter((a) => a.length > 0)
    .sort((a, b) => b.length - a.length);

  let filtered = n;
  for (const allow of allowSorted) {
    const re = new RegExp(`\\b${escapeRegex(allow)}\\b`, 'g');
    filtered = filtered.replace(re, ' '.repeat(allow.length));
  }

  const found = new Map<string, { canonical: string; term: string }>();

  for (const entry of ALLERGEN_TERMS) {
    for (const rawTerm of entry.terms) {
      const term = normalize(rawTerm);
      if (!term) continue;
      const searchIn = BARE_TERMS.has(term) ? filtered : n;
      const re = new RegExp(`\\b${escapeRegex(term)}\\b`);
      if (re.test(searchIn)) {
        if (!found.has(entry.canonical)) {
          found.set(entry.canonical, { canonical: entry.canonical, term });
        }
        break;
      }
    }
  }

  return Array.from(found.values());
}

// Note: "try" is included alongside the other consumption verbs
// (give/eat/feed/take/serve) because bare exhortations like "try the pesto"
// must HOLD. Adding it follows the documented bias: a missed HOLD on an
// allergen is worse than an extra HOLD.
export const AFFIRMATIVE_CONTEXT: string[] = [
  'give',
  'gives',
  'giving',
  'gave',
  'eat',
  'eats',
  'eating',
  'ate',
  'feed',
  'feeding',
  'fed',
  'can have',
  'could have',
  'have the',
  'has the',
  'safe',
  'fine',
  'ok',
  'okay',
  'ok to',
  'fine to',
  'allowed',
  'go for it',
  'great choice',
  'no problem',
  'take',
  'takes',
  'taking',
  'dose',
  'dosed',
  'prescribe',
  'prescribed',
  'recipe',
  'ingredient',
  'serve',
  'served',
  'order the',
  'try',
];

// Cautionary markers soften an affirmative match back to PASS — UNLESS the
// affirmative is a direct safety affirmation ("safe", "fine", "ok", ...),
// in which case we still HOLD. A marker only softens when it occurs within
// CAUTIONARY_PROXIMITY_TOKENS of a matched allergen term (see screenOutbound).
const CAUTIONARY_MARKERS = [
  'do not',
  'dont',
  'don t',
  'avoid',
  'never',
  'allergic',
  'allergy',
  'exclude',
  'cannot',
  'cant',
  'can t',
  'must not',
  'mustn t',
  'should not',
  'shouldn t',
  'without',
];

// Proximity window (in whitespace-delimited tokens). A cautionary marker
// softens an affirmative only when it shares a span of FEWER than this many
// tokens with the matched allergen (i.e. marker and allergen both fit in a
// 5-or-fewer-token sub-sequence). Set tight enough that "do not forget —
// try the pesto" still HOLDs: "do not" begins at token 0, "pesto" at
// token 5, so the inclusive span is 6 tokens — outside the window.
const CAUTIONARY_PROXIMITY_TOKENS = 6;

const SAFETY_AFFIRMATIONS = new Set([
  'safe',
  'fine',
  'ok',
  'okay',
  'ok to',
  'fine to',
  'can have',
  'could have',
]);

/**
 * NARROW context-gated allergen backstop.
 *
 * Decision D1=C (CONTEXT-GATED HOLD, NARROW):
 *   - no allergen           -> pass
 *   - allergen + affirmative -> hold
 *     (unless a cautionary marker is present near the allergen AND the
 *      affirmative is not a direct safety affirmation, then pass)
 *   - allergen + no affirmative -> pass
 *
 * Caller contract: if this function ever throws (it should not), the caller
 * MUST treat the result as a HOLD. The function guards internally to keep
 * that path cold.
 */
export function screenOutbound(text: string): {
  action: 'pass' | 'hold';
  matched: string[];
  reason: string;
} {
  try {
    if (typeof text !== 'string' || text.length === 0) {
      return { action: 'pass', matched: [], reason: 'empty input' };
    }

    const matches = findAllergens(text);
    if (matches.length === 0) {
      return { action: 'pass', matched: [], reason: 'no allergen mention' };
    }

    const matchedCanonicals = matches.map((m) => m.canonical);
    const n = normalize(text);

    const affirmativesFound: string[] = [];
    for (const aff of AFFIRMATIVE_CONTEXT) {
      const a = normalize(aff);
      if (!a) continue;
      const re = new RegExp(`\\b${escapeRegex(a)}\\b`);
      if (re.test(n)) affirmativesFound.push(a);
    }

    if (affirmativesFound.length === 0) {
      return {
        action: 'pass',
        matched: matchedCanonicals,
        reason: `allergen mention (${matchedCanonicals.join(',')}) but no affirmative context`,
      };
    }

    const hasSafetyAffirmation = affirmativesFound.some((a) =>
      SAFETY_AFFIRMATIONS.has(a),
    );

    // Locate every allergen match in token space so proximity can be
    // measured per-occurrence (not text-globally). For each matched
    // canonical, scan for the FIRST token-position of any of its terms.
    const tokens = n.split(' ');
    const allergenTokenPositions: number[] = [];
    for (const m of matches) {
      const termTokens = m.term.split(' ');
      for (let i = 0; i + termTokens.length <= tokens.length; i++) {
        let hit = true;
        for (let j = 0; j < termTokens.length; j++) {
          if (tokens[i + j] !== termTokens[j]) {
            hit = false;
            break;
          }
        }
        if (hit) {
          // Position of the first token of the matched term occurrence
          allergenTokenPositions.push(i);
        }
      }
    }

    // For each cautionary marker, locate its token range(s) and test
    // proximity to each allergen occurrence. A marker softens iff some
    // (marker, allergen) pair shares a span of < CAUTIONARY_PROXIMITY_TOKENS
    // inclusive tokens — keeping a cautionary phrase tied to the nearby
    // allergen rather than letting "do not" at the start of one clause
    // override an affirmative in a later clause.
    let hasCautionary = false;
    outer: for (const c of CAUTIONARY_MARKERS) {
      const markerTokens = normalize(c).split(' ').filter((t) => t.length > 0);
      if (markerTokens.length === 0) continue;
      for (let i = 0; i + markerTokens.length <= tokens.length; i++) {
        let hit = true;
        for (let j = 0; j < markerTokens.length; j++) {
          if (tokens[i + j] !== markerTokens[j]) {
            hit = false;
            break;
          }
        }
        if (!hit) continue;
        const markerStart = i;
        const markerEnd = i + markerTokens.length - 1;
        for (const allergenPos of allergenTokenPositions) {
          const span =
            Math.max(markerEnd, allergenPos) -
            Math.min(markerStart, allergenPos) +
            1;
          if (span < CAUTIONARY_PROXIMITY_TOKENS) {
            hasCautionary = true;
            break outer;
          }
        }
      }
    }

    // Existing "no <term>" proximity check: a literal "no <allergen-term>"
    // is always a cautionary regardless of the marker-list above.
    if (!hasCautionary) {
      for (const m of matches) {
        const re = new RegExp(`\\bno\\s+${escapeRegex(m.term)}\\b`);
        if (re.test(n)) {
          hasCautionary = true;
          break;
        }
      }
    }

    if (hasCautionary && !hasSafetyAffirmation) {
      return {
        action: 'pass',
        matched: matchedCanonicals,
        reason: `allergen (${matchedCanonicals.join(',')}) appears in cautionary context (softened)`,
      };
    }

    return {
      action: 'hold',
      matched: matchedCanonicals,
      reason: `allergen (${matchedCanonicals.join(',')}) appears with affirmative context (${affirmativesFound.join(',')})`,
    };
  } catch {
    return {
      action: 'hold',
      matched: [],
      reason: 'screenOutbound internal error — defaulting to HOLD',
    };
  }
}

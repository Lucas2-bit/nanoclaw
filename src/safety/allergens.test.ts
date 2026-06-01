import { describe, it, expect } from 'vitest';

import {
  ALLERGEN_TERMS,
  AFFIRMATIVE_CONTEXT,
  FALSE_POSITIVE_ALLOWLIST,
  SAFETY_BLOCK,
  findAllergens,
  normalize,
  screenOutbound,
} from './allergens.js';

// --- normalize ---

describe('normalize', () => {
  it('lowercases and strips punctuation to spaces', () => {
    expect(normalize('SESAME!')).toBe('sesame');
    expect(normalize('sesame.')).toBe('sesame');
  });

  it('replaces hyphens with spaces', () => {
    expect(normalize('egg-free')).toBe('egg free');
    expect(normalize('co-amoxiclav')).toBe('co amoxiclav');
  });

  it('collapses whitespace', () => {
    expect(normalize('  hello   world  ')).toBe('hello world');
  });

  it('handles empty and whitespace-only input', () => {
    expect(normalize('')).toBe('');
    expect(normalize('   ')).toBe('');
  });
});

// --- findAllergens ---

describe('findAllergens', () => {
  it('matches a direct term', () => {
    expect(findAllergens('eggs for breakfast').map((x) => x.canonical)).toEqual(
      ['egg'],
    );
  });

  it('returns empty for benign text', () => {
    expect(findAllergens('the cat sat on the mat')).toEqual([]);
    expect(findAllergens('')).toEqual([]);
  });

  it('respects allowlist for bare egg/nut variants', () => {
    expect(findAllergens('add nutmeg')).toEqual([]);
    expect(findAllergens('butternut squash soup')).toEqual([]);
    expect(findAllergens('eggplant parmesan')).toEqual([]);
    expect(findAllergens('this is egg-free')).toEqual([]);
    expect(findAllergens('doughnut for dessert')).toEqual([]);
  });

  it('matches coconut as coconut only, never as nut', () => {
    const r = findAllergens('coconut water');
    expect(r.map((x) => x.canonical)).toEqual(['coconut']);
  });

  it('matches hidden egg sources', () => {
    expect(findAllergens('the aioli is rich').map((x) => x.canonical)).toEqual([
      'egg',
    ]);
    expect(
      findAllergens('pasta with mayonnaise').map((x) => x.canonical),
    ).toEqual(['egg']);
  });

  it('matches hidden sesame sources', () => {
    expect(findAllergens('hummus plate').map((x) => x.canonical)).toEqual([
      'sesame',
    ]);
    expect(findAllergens('tahini sauce').map((x) => x.canonical)).toEqual([
      'sesame',
    ]);
  });

  it('matches drug brand names', () => {
    expect(findAllergens('Augmentin').map((x) => x.canonical)).toEqual([
      'amoxicillin',
    ]);
    expect(findAllergens('Bactrim tonight').map((x) => x.canonical)).toEqual([
      'g6pd_drugs',
    ]);
    expect(findAllergens('Macrobid').map((x) => x.canonical)).toEqual([
      'g6pd_drugs',
    ]);
    expect(findAllergens('Cipro').map((x) => x.canonical)).toEqual([
      'g6pd_drugs',
    ]);
    expect(findAllergens('Levaquin').map((x) => x.canonical)).toEqual([
      'g6pd_drugs',
    ]);
  });

  it('matches multi-word phrases', () => {
    expect(findAllergens('fresh fava beans').map((x) => x.canonical)).toEqual([
      'fava',
    ]);
    expect(findAllergens('a pine nut pesto').map((x) => x.canonical)).toEqual([
      'nuts',
    ]);
  });

  it('dedupes by canonical when multiple terms hit', () => {
    const r = findAllergens('eggs and mayonnaise');
    expect(r.filter((x) => x.canonical === 'egg').length).toBe(1);
  });
});

// --- screenOutbound ---

describe('screenOutbound — F1 nuts', () => {
  it('HOLDs "Oliver can have the almond croissant"', () => {
    expect(screenOutbound('Oliver can have the almond croissant').action).toBe(
      'hold',
    );
  });

  it('HOLDs "marzipan cake is fine for him"', () => {
    expect(screenOutbound('marzipan cake is fine for him').action).toBe('hold');
  });

  it('HOLDs "try the pesto"', () => {
    expect(screenOutbound('try the pesto').action).toBe('hold');
  });

  it('HOLDs "Nutella on toast, go for it"', () => {
    expect(screenOutbound('Nutella on toast, go for it').action).toBe('hold');
  });
});

describe('screenOutbound — F1 nut false positives', () => {
  it('PASSes "add nutmeg"', () => {
    expect(screenOutbound('add nutmeg').action).toBe('pass');
  });

  it('PASSes "butternut squash soup is fine"', () => {
    expect(screenOutbound('butternut squash soup is fine').action).toBe('pass');
  });

  it('matches "coconut water" as coconut canonical only (not nut)', () => {
    const finds = findAllergens('coconut water');
    expect(finds.map((x) => x.canonical)).toEqual(['coconut']);
    expect(screenOutbound('coconut water').action).toBe('pass');
  });
});

describe('screenOutbound — F2 drug brands', () => {
  it('HOLDs "Augmentin is fine for Oliver"', () => {
    expect(screenOutbound('Augmentin is fine for Oliver').action).toBe('hold');
  });

  it('HOLDs "give him Bactrim"', () => {
    expect(screenOutbound('give him Bactrim').action).toBe('hold');
  });

  it('HOLDs "Macrobid prescribed"', () => {
    expect(screenOutbound('Macrobid prescribed').action).toBe('hold');
  });

  it('HOLDs "Cipro is ok"', () => {
    expect(screenOutbound('Cipro is ok').action).toBe('hold');
  });

  it('HOLDs "Levaquin is safe"', () => {
    expect(screenOutbound('Levaquin is safe').action).toBe('hold');
  });
});

describe('screenOutbound — F8 egg hidden + allowlist', () => {
  it('HOLDs "the aioli is safe for Oliver"', () => {
    expect(screenOutbound('the aioli is safe for Oliver').action).toBe('hold');
  });

  it('HOLDs "fresh pasta with mayonnaise, fine for him"', () => {
    expect(
      screenOutbound('fresh pasta with mayonnaise, fine for him').action,
    ).toBe('hold');
  });

  it('PASSes "eggplant parmesan is fine"', () => {
    expect(screenOutbound('eggplant parmesan is fine').action).toBe('pass');
  });

  it('PASSes "this is egg-free"', () => {
    expect(screenOutbound('this is egg-free').action).toBe('pass');
  });
});

describe('screenOutbound — sesame hidden', () => {
  it('HOLDs "hummus and tahini plate, go for it"', () => {
    expect(screenOutbound('hummus and tahini plate, go for it').action).toBe(
      'hold',
    );
  });
});

describe('screenOutbound — cautionary negatives', () => {
  it('PASSes "do NOT give Oliver egg"', () => {
    expect(screenOutbound('do NOT give Oliver egg').action).toBe('pass');
  });

  it('PASSes "Oliver is allergic to sesame"', () => {
    expect(screenOutbound('Oliver is allergic to sesame').action).toBe('pass');
  });

  it('PASSes "this contains walnut, avoid it"', () => {
    expect(screenOutbound('this contains walnut, avoid it').action).toBe(
      'pass',
    );
  });

  it('HOLDs a direct safety affirmation even with cautionary context nearby', () => {
    // Mixed signal: cautionary marker + direct "safe" affirmation -> HOLD.
    // Documented in module; safety affirmation overrides cautionary softening.
    expect(
      screenOutbound('Oliver is allergic to nuts but Nutella is safe').action,
    ).toBe('hold');
  });
});

describe('screenOutbound — bare mention vs affirmative', () => {
  it('HOLDs "the recipe lists egg" (recipe is affirmative)', () => {
    expect(screenOutbound('the recipe lists egg').action).toBe('hold');
  });

  it('PASSes "we discussed his egg allergy" (no affirmative)', () => {
    expect(screenOutbound('we discussed his egg allergy').action).toBe('pass');
  });
});

describe('screenOutbound — normalization', () => {
  it('matches "SESAME!"', () => {
    const r = screenOutbound('SESAME!');
    expect(r.matched).toContain('sesame');
  });

  it('matches "sesame."', () => {
    const r = screenOutbound('sesame.');
    expect(r.matched).toContain('sesame');
  });

  it('matches plural "eggs"', () => {
    const r = screenOutbound('eggs');
    expect(r.matched).toContain('egg');
  });
});

describe('screenOutbound — contract', () => {
  it('never throws for normal string input', () => {
    expect(() => screenOutbound('')).not.toThrow();
    expect(() => screenOutbound('regular text')).not.toThrow();
    expect(() => screenOutbound('!@#$%^&*()')).not.toThrow();
    expect(() => screenOutbound('a'.repeat(10000))).not.toThrow();
  });

  it('returns pass for empty input', () => {
    expect(screenOutbound('').action).toBe('pass');
  });
});

// --- exported data shape ---

describe('exports', () => {
  it('SAFETY_BLOCK contains the canonical facts', () => {
    expect(SAFETY_BLOCK).toContain('SAFETY-CRITICAL');
    expect(SAFETY_BLOCK).toContain('Oliver');
    expect(SAFETY_BLOCK).toContain('Alexander');
    expect(SAFETY_BLOCK).toContain('G6PD');
    expect(SAFETY_BLOCK).toContain('g6pd.org');
    expect(SAFETY_BLOCK).toContain('erythromycin');
    expect(SAFETY_BLOCK).toContain('amoxicillin');
    expect(SAFETY_BLOCK).toContain('sesame');
    expect(SAFETY_BLOCK).toContain('fava');
  });

  it('ALLERGEN_TERMS covers all required canonicals', () => {
    const names = ALLERGEN_TERMS.map((e) => e.canonical);
    expect(names).toEqual(
      expect.arrayContaining([
        'egg',
        'nuts',
        'coconut',
        'erythromycin',
        'amoxicillin',
        'sesame',
        'celery',
        'fava',
        'g6pd_drugs',
      ]),
    );
  });

  it('FALSE_POSITIVE_ALLOWLIST includes the required entries', () => {
    expect(FALSE_POSITIVE_ALLOWLIST).toEqual(
      expect.arrayContaining([
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
      ]),
    );
  });

  it('AFFIRMATIVE_CONTEXT includes the core verbs and affirmations', () => {
    expect(AFFIRMATIVE_CONTEXT).toEqual(
      expect.arrayContaining([
        'give',
        'eat',
        'feed',
        'safe',
        'fine',
        'ok',
        'can have',
        'recipe',
        'prescribed',
        'go for it',
      ]),
    );
  });
});

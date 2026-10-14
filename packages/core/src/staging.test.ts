import { describe, expect, it } from 'vitest';
import { aloneSet, clearanceKey, goingWithout, lintMigrations, migrationKey, migrationsNeedReset, promotionLevel, promotionSet, stagingWorkerName } from './staging.js';

const rules = [
  { paths: ['website/src/**/*.css', 'website/index.html', 'website/content/**'], level: 'self' as const },
  { paths: ['api/migrations/**', 'api/src/**'], level: 'classify' as const },
  { paths: ['**/wrangler.jsonc', '**/package.json', '**/pnpm-lock.yaml'], level: 'developer' as const },
];

describe('promotionLevel', () => {
  it('takes the strictest level across paths; first matching rule wins', () => {
    const r = promotionLevel(rules, ['website/index.html', 'api/src/app.ts']);
    expect(r.level).toBe('classify');
    expect(r.perPath).toEqual([
      { path: 'website/index.html', level: 'self', rule: 0 },
      { path: 'api/src/app.ts', level: 'classify', rule: 1 },
    ]);
  });
  it('unmatched paths are developer', () => {
    expect(promotionLevel(rules, ['website/src/main.ts']).level).toBe('developer');
    expect(promotionLevel(rules, ['website/src/main.ts']).perPath[0]).toEqual({ path: 'website/src/main.ts', level: 'developer', rule: null });
  });
  it('a later stricter rule does not override an earlier match', () => {
    expect(promotionLevel(rules, ['api/src/wrangler.jsonc']).level).toBe('classify');
  });
  it('no changed paths is self', () => {
    expect(promotionLevel(rules, []).level).toBe('self');
  });
});

describe('lintMigrations', () => {
  const init = { '0001_init.sql': 'CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);' };
  it('new tables, indexes and nullable or defaulted columns are additive', () => {
    const next = {
      ...init,
      '0002_phone.sql': `-- add phone\nALTER TABLE contacts ADD COLUMN phone TEXT;\nALTER TABLE contacts ADD COLUMN opted_in INTEGER NOT NULL DEFAULT 0;\nCREATE INDEX contacts_phone ON contacts (phone);\nCREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY);`,
    };
    expect(lintMigrations(init, next)).toEqual({ kind: 'additive', offending: [] });
  });
  it('NOT NULL without a default is destructive', () => {
    const r = lintMigrations(init, { ...init, '0002.sql': 'ALTER TABLE contacts ADD COLUMN email TEXT NOT NULL;' });
    expect(r.kind).toBe('destructive');
    expect(r.offending).toEqual([{ file: '0002.sql', statement: 'ALTER TABLE contacts ADD COLUMN email TEXT NOT NULL' }]);
  });
  it('drops, renames, updates and deletes are destructive', () => {
    for (const sql of ['DROP TABLE contacts', 'ALTER TABLE contacts RENAME COLUMN name TO full_name', "UPDATE contacts SET name = 'x'", 'DELETE FROM contacts', 'ALTER TABLE contacts DROP COLUMN name']) {
      expect(lintMigrations(init, { ...init, '0002.sql': `${sql};` }).kind).toBe('destructive');
    }
  });
  it('editing or removing an existing migration file is destructive', () => {
    expect(lintMigrations(init, { '0001_init.sql': 'CREATE TABLE contacts (id INTEGER PRIMARY KEY);' })).toEqual({ kind: 'destructive', offending: [{ file: '0001_init.sql', statement: '(existing migration changed)' }] });
    expect(lintMigrations(init, {})).toEqual({ kind: 'destructive', offending: [{ file: '0001_init.sql', statement: '(existing migration removed)' }] });
  });
  it('semicolons inside string literals do not split statements', () => {
    expect(lintMigrations({}, { '0001.sql': "CREATE TABLE t (a TEXT DEFAULT 'x;y');" }).kind).toBe('additive');
  });
});

describe('migrationsNeedReset', () => {
  it('only when the applied list is not a prefix of the next one', () => {
    expect(migrationsNeedReset([], ['0001.sql'])).toBe(false);
    expect(migrationsNeedReset(['0001.sql'], ['0001.sql', '0002.sql'])).toBe(false);
    expect(migrationsNeedReset(['0001.sql', '0002.sql'], ['0001.sql'])).toBe(true);
    expect(migrationsNeedReset(['0001.sql', '0002.sql'], ['0001.sql', '0003.sql', '0002.sql'])).toBe(true);
  });
  it('compares name@sha256 keys by name and content; an edited applied migration needs a reset', () => {
    const [a, b] = ['a'.repeat(64), 'b'.repeat(64)];
    expect(migrationKey('0001.sql', a)).toBe(`0001.sql@${a}`);
    // unchanged content: no reset
    expect(migrationsNeedReset([migrationKey('0001.sql', a)], [migrationKey('0001.sql', a), migrationKey('0002.sql', b)])).toBe(false);
    // the applied file's content changed: reset
    expect(migrationsNeedReset([migrationKey('0001.sql', a)], [migrationKey('0001.sql', b)])).toBe(true);
    // an older applied entry without @sha compares by name only
    expect(migrationsNeedReset(['0001.sql'], [migrationKey('0001.sql', b), migrationKey('0002.sql', a)])).toBe(false);
    expect(migrationsNeedReset(['0001.sql'], [migrationKey('0002.sql', a)])).toBe(true);
  });
});

describe('stagingWorkerName', () => {
  it('appends -staging and refuses names that become too long', () => {
    expect(stagingWorkerName('cfapp-o-0123456789ab-api')).toBe('cfapp-o-0123456789ab-api-staging');
    expect(() => stagingWorkerName(`cfapp-o-0123456789ab-${'x'.repeat(40)}`)).toThrow(/63/);
  });
});

describe('lintMigrations hardening', () => {
  it('[bracket] identifiers are quoted: a DROP hidden behind a bracketed quote is found', () => {
    const sql = "CREATE TABLE t ([a'b] TEXT); DROP TABLE x; CREATE TABLE u ([c'd] TEXT);";
    const r = lintMigrations({}, { '0002.sql': sql });
    expect(r.kind).toBe('destructive');
    expect(r.offending.map((o) => o.statement)).toEqual(['DROP TABLE x']);
  });
  it("doubled quotes, block comments and ';' inside comments do not split statements", () => {
    const sql = "CREATE TABLE a (n TEXT DEFAULT 'it''s; fine'); /* DROP TABLE a; */ -- DELETE FROM a;\nCREATE INDEX a_n ON a (n);";
    expect(lintMigrations({}, { '0002.sql': sql })).toEqual({ kind: 'additive', offending: [] });
  });
  it('NOT NULL / DEFAULT inside literals or CHECK clauses do not count', () => {
    const fake = "ALTER TABLE c ADD COLUMN x TEXT NOT NULL CHECK (x <> 'DEFAULT');";
    expect(lintMigrations({}, { '0002.sql': fake }).kind).toBe('destructive');
    const ok = "ALTER TABLE c ADD COLUMN y TEXT CHECK (y <> 'NOT NULL');";
    expect(lintMigrations({}, { '0002.sql': ok }).kind).toBe('additive');
  });
  it('file names that are Object.prototype keys are ordinary names', () => {
    expect(lintMigrations({}, { constructor: 'CREATE TABLE z (id INTEGER);' }).kind).toBe('additive');
    expect(lintMigrations({ toString: 'CREATE TABLE z (id INTEGER);' }, {}).kind).toBe('destructive');
    expect(lintMigrations({}, { constructor: 'DROP TABLE x;' }).kind).toBe('destructive');
  });
});

describe('promotionSet', () => {
  const ls = [
    { landingId: 'l1', seq: 1, paths: ['website/index.html'] },
    { landingId: 'l2', seq: 2, paths: ['api/src/app.ts'] },
    { landingId: 'l3', seq: 3, paths: ['website/index.html', 'api/src/contacts.ts'] },
    { landingId: 'l4', seq: 4, paths: ['api/src/contacts.ts'] },
  ];
  it('a landing with no overlap is promoted alone', () => {
    expect(promotionSet(ls, 'l2')).toEqual(['l2']);
  });
  it('earlier overlapping landings join, transitively, in seq order; later ones never do', () => {
    expect(promotionSet(ls, 'l4')).toEqual(['l1', 'l3', 'l4']);
    expect(promotionSet(ls, 'l3')).toEqual(['l1', 'l3']);
  });
  it('an unknown target throws', () => {
    expect(() => promotionSet(ls, 'nope')).toThrow(/unknown landing/);
  });
  it('a landing a revision was seeded on (after) joins although it is later, with its own earlier overlaps', () => {
    const withAfter = [
      { landingId: 'l1', seq: 1, paths: ['api/src/app.ts'] },
      { landingId: 'l2', seq: 2, paths: ['website/index.html', 'website/about.html'], after: ['l4'] },
      { landingId: 'l3', seq: 3, paths: ['api/src/app.ts', 'website/about.html'] },
      { landingId: 'l4', seq: 4, paths: ['website/index.html'] },
      { landingId: 'l5', seq: 5, paths: ['website/index.html'] },
    ];
    // l4 is after l2 in seq but l2's revision builds on it; l3 is l4's earlier overlap (shares about.html with l2 too), l1 l3's
    expect(promotionSet(withAfter, 'l2')).toEqual(['l1', 'l2', 'l3', 'l4']);
    // without the after edge only earlier landings count
    expect(promotionSet(withAfter.map(({ after: _a, ...l }) => l), 'l2')).toEqual(['l2']);
  });
  it('an after id that names no landing, or a disjoint after landing, is ignored', () => {
    expect(promotionSet([{ landingId: 'a', seq: 1, paths: ['x'], after: ['nope', 'b'] }, { landingId: 'b', seq: 2, paths: ['y'] }], 'a')).toEqual(['a']);
  });
});

describe('clearanceKey', () => {
  it('changes with any proposal hash or their order, and ignores object key order', () => {
    const a = clearanceKey({ proposalHashes: ['h1', 'h2'] });
    expect(clearanceKey({ proposalHashes: ['h1', 'h2'] })).toBe(a);
    expect(clearanceKey({ proposalHashes: ['h1', 'h3'] })).not.toBe(a);
    expect(clearanceKey({ proposalHashes: ['h2', 'h1'] })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('lintMigrations fails closed', () => {
  const kind = (sql: string) => lintMigrations({}, { '0002.sql': sql }).kind;
  it('non-ASCII whitespace or identifier characters outside quotes are never additive', () => {
    expect(kind('ALTER TABLE t\u00a0ADD DROP COLUMN secret;')).toBe('destructive');
    expect(kind('ALTER TABLE t\u00a0ADD RENAME TO gone;')).toBe('destructive');
    expect(kind('ALTER TABLE t\u3000ADD DROP COLUMN secret;')).toBe('destructive');
    expect(kind('ALTER TABLE t\ufeffADD DROP COLUMN secret;')).toBe('destructive');
    expect(kind('ALTER TABLE t ADD COLUMN x \u00e9DEFAULT NOT NULL;')).toBe('destructive');
  });
  it('non-ASCII inside a string literal default is fine', () => {
    expect(kind("ALTER TABLE t ADD COLUMN n TEXT DEFAULT 'caf\u00e9';")).toBe('additive');
  });
  it('quoted table names in ALTER ... ADD stay additive; NOT NULL without DEFAULT does not', () => {
    expect(kind('ALTER TABLE "users" ADD COLUMN x TEXT;')).toBe('additive');
    expect(kind('ALTER TABLE [users] ADD COLUMN x TEXT;')).toBe('additive');
    expect(kind('ALTER TABLE `users` ADD COLUMN x TEXT;')).toBe('additive');
    expect(kind('ALTER TABLE "users" ADD COLUMN x TEXT NOT NULL;')).toBe('destructive');
  });
  it('anything but CREATE TABLE / CREATE INDEX / ADD COLUMN is destructive', () => {
    expect(kind('CREATE TRIGGER g AFTER INSERT ON t BEGIN SELECT 1; END;')).toBe('destructive');
    expect(kind('CREATE VIEW v AS SELECT 1;')).toBe('destructive');
    expect(kind('PRAGMA foreign_keys = OFF;')).toBe('destructive');
    expect(kind("ATTACH DATABASE 'x.db' AS x;")).toBe('destructive');
    expect(kind('CREATE TEMP TABLE tmp (id INTEGER);')).toBe('destructive');
  });
});

describe('promotionSet with forced predecessors', () => {
  const ls = [
    { landingId: 'l1', seq: 1, paths: ['website/index.html'] },
    { landingId: 'l2', seq: 2, paths: ['api/src/app.ts'] },
    { landingId: 'l3', seq: 3, paths: ['website/index.html', 'api/src/x.ts'] },
    { landingId: 'l4', seq: 4, paths: ['api/src/contacts.ts'], with: ['l2'] },
  ];
  it('a `with` landing joins without sharing a path, and brings its own overlaps', () => {
    expect(promotionSet(ls, 'l4')).toEqual(['l2', 'l4']);
    const ls2 = [...ls.slice(0, 3), { landingId: 'l4', seq: 4, paths: ['api/src/contacts.ts'], with: ['l3'] }];
    expect(promotionSet(ls2, 'l4')).toEqual(['l1', 'l3', 'l4']);
  });
  it('without `with` the result is unchanged', () => {
    expect(promotionSet(ls.slice(0, 3), 'l3')).toEqual(['l1', 'l3']);
  });
});

describe('aloneSet / goingWithout', () => {
  const ls = [
    { landingId: 'l1', seq: 1, paths: ['website/index.html'] },
    { landingId: 'l2', seq: 2, paths: ['api/src/app.ts'] },
    { landingId: 'l3', seq: 3, paths: ['website/index.html'], with: ['l2'] },
    { landingId: 'l4', seq: 4, paths: ['website/index.html'] },
  ];
  it('alone = the target and its with-chain, never its path overlaps', () => {
    expect(aloneSet(ls, 'l4')).toEqual(['l4']);
    expect(aloneSet(ls, 'l3')).toEqual(['l2', 'l3']);
  });
  it('goingWithout = closure minus alone, in seq order', () => {
    expect(goingWithout(ls, 'l4')).toEqual(['l1', 'l2', 'l3']);
    expect(goingWithout(ls, 'l3')).toEqual(['l1']);
  });
  it('unknown targets throw; unknown with ids are ignored', () => {
    expect(() => aloneSet(ls, 'nope')).toThrow(/unknown landing/);
    expect(aloneSet([{ landingId: 'a', seq: 1, paths: [], with: ['gone'] }], 'a')).toEqual(['a']);
  });
});

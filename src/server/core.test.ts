import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type BanRequest,
  type Config,
  DEFAULT_CONFIG,
  type Deps,
  durationError,
  type Karma,
  parseConfig,
  processComment,
  thresholdError,
} from './core.ts';

const EVENT = { commentId: 't1_abc', authorName: 'SomeUser', subredditName: 'testsub' };

/** A fake Reddit that records what Crowd Boot did. */
function fake(karma: Karma, overrides: Partial<Config> = {}, extra: Partial<Deps> = {}) {
  const removed: string[] = [];
  const bans: BanRequest[] = [];
  const logs: string[] = [];
  const deps: Deps = {
    getConfig: async () => ({ ...DEFAULT_CONFIG, ...overrides }),
    getKarma: async () => karma,
    isModerator: async () => false,
    isApproved: async () => false,
    removeComment: async (id) => void removed.push(id),
    banUser: async (request) => void bans.push(request),
    appUsername: 'crowd-boot',
    log: (message) => void logs.push(message),
    ...extra,
  };
  return { deps, removed, bans, logs };
}

test('leaves users with zero or positive karma alone', async () => {
  for (const karma of [{}, { fromComments: 0 }, { fromComments: 5, fromPosts: -2 }]) {
    const f = fake(karma);
    const outcome = await processComment(EVENT, f.deps);
    assert.deepEqual([outcome.removed, outcome.banned], [false, false]);
    assert.deepEqual([f.removed, f.bans], [[], []]);
  }
});

test('removes the comment but does not ban between the two thresholds', async () => {
  for (const fromComments of [-1, -10]) {
    const f = fake({ fromComments });
    const outcome = await processComment(EVENT, f.deps);
    assert.deepEqual([outcome.removed, outcome.banned], [true, false]);
    assert.deepEqual(f.removed, ['t1_abc']);
    assert.deepEqual(f.bans, []);
  }
});

test('removes and bans below the ban threshold', async () => {
  const f = fake({ fromComments: -8, fromPosts: -3 });
  const outcome = await processComment(EVENT, f.deps);
  assert.deepEqual([outcome.karma, outcome.removed, outcome.banned], [-11, true, true]);
  assert.equal(f.bans.length, 1);
  const ban = f.bans[0]!;
  assert.equal(ban.username, 'SomeUser');
  assert.equal(ban.subredditName, 'testsub');
  assert.equal(ban.context, 't1_abc');
  assert.equal(ban.duration, undefined, 'default ban is permanent');
  assert.match(ban.message, /u\/SomeUser.*r\/testsub.*-11.*-10/s);
  assert.ok(ban.reason.length <= 100 && ban.note.length <= 300);
});

test('"comments only" ignores post karma', async () => {
  const f = fake({ fromComments: 2, fromPosts: -50 }, { karmaSource: 'comments' });
  const outcome = await processComment(EVENT, f.deps);
  assert.deepEqual([outcome.karma, outcome.removed, outcome.banned], [2, false, false]);
});

test('temporary bans pass the duration through', async () => {
  const f = fake({ fromComments: -99 }, { banDurationDays: 7 });
  await processComment(EVENT, f.deps);
  assert.equal(f.bans[0]?.duration, 7);
});

test('each action can be switched off', async () => {
  const noBan = fake({ fromComments: -99 }, { banEnabled: false });
  await processComment(EVENT, noBan.deps);
  assert.deepEqual([noBan.removed.length, noBan.bans.length], [1, 0]);

  const noRemove = fake({ fromComments: -99 }, { removeEnabled: false });
  await processComment(EVENT, noRemove.deps);
  assert.deepEqual([noRemove.removed.length, noRemove.bans.length], [0, 1]);
});

test('the default ban message points the user to the moderators', async () => {
  const f = fake({ fromComments: -99 });
  await processComment(EVENT, f.deps);
  assert.match(f.bans[0]!.message, /please contact the moderators of this subreddit\.$/);
});

test('never acts on moderators, approved users, exempt users or bots', async () => {
  const cases: [string, ReturnType<typeof fake>, typeof EVENT][] = [
    ['moderator', fake({ fromComments: -99 }, {}, { isModerator: async () => true }), EVENT],
    ['approved user', fake({ fromComments: -99 }, {}, { isApproved: async () => true }), EVENT],
    ['exempt user', fake({ fromComments: -99 }, { exemptUsers: new Set(['someuser']) }), EVENT],
    ['system account', fake({ fromComments: -99 }), { ...EVENT, authorName: 'AutoModerator' }],
    ['system account', fake({ fromComments: -99 }), { ...EVENT, authorName: 'crowd-boot' }],
  ];
  for (const [reason, f, event] of cases) {
    const outcome = await processComment(event, f.deps);
    assert.equal(outcome.skipped, reason);
    assert.deepEqual([f.removed, f.bans], [[], []]);
  }
});

test('approved users are not exempt when that setting is off', async () => {
  const f = fake({ fromComments: -99 }, { exemptApproved: false }, { isApproved: async () => true });
  const outcome = await processComment(EVENT, f.deps);
  assert.deepEqual([outcome.removed, outcome.banned], [true, true]);
});

test('a failed removal does not stop the ban, and vice versa', async () => {
  const boom = async () => {
    throw new Error('reddit is down');
  };
  const a = fake({ fromComments: -99 }, {}, { removeComment: boom });
  const outcomeA = await processComment(EVENT, a.deps);
  assert.deepEqual([outcomeA.removed, outcomeA.banned], [false, true]);

  const b = fake({ fromComments: -99 }, {}, { banUser: boom });
  const outcomeB = await processComment(EVENT, b.deps);
  assert.deepEqual([outcomeB.removed, outcomeB.banned], [true, false]);
  assert.match(b.logs.join('\n'), /FAILED to ban/);
});

test('parseConfig applies defaults and caps unsafe values', () => {
  assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);

  const config = parseConfig({
    karmaSource: ['comments'],
    removeBelow: 5,
    banBelow: 20,
    banDurationDays: 5000,
    banMessage: '   ',
    exemptUsers: 'Alice, u/Bob  /u/carol,',
  });
  assert.equal(config.karmaSource, 'comments');
  assert.equal(config.removeBelow, 0, 'positive thresholds are capped at 0');
  assert.equal(config.banBelow, 0);
  assert.equal(config.banDurationDays, 999);
  assert.equal(config.banMessage, DEFAULT_CONFIG.banMessage);
  assert.deepEqual([...config.exemptUsers], ['alice', 'bob', 'carol']);
});

test('settings validators', () => {
  assert.equal(thresholdError(0), undefined);
  assert.equal(thresholdError(-25), undefined);
  assert.ok(thresholdError(1));
  assert.ok(thresholdError(-1.5));
  assert.ok(thresholdError(undefined));
  assert.equal(durationError(0), undefined);
  assert.equal(durationError(999), undefined);
  assert.ok(durationError(-1));
  assert.ok(durationError(1000));
});

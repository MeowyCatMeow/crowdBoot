import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type BanRequest,
  type Config,
  DEFAULT_CONFIG,
  type Deps,
  durationError,
  type Karma,
  type ModActionDeps,
  parseConfig,
  processComment,
  processCommentDelete,
  processModAction,
  type Store,
  thresholdError,
} from './core.ts';

const EVENT = { commentId: 't1_abc', authorName: 'SomeUser', subredditName: 'testsub' };

/** An in-memory stand-in for the app's storage. */
function memoryStore(): Store & { data: Map<string, string>; ttls: Map<string, number> } {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    data,
    ttls,
    get: async (key) => data.get(key),
    set: async (key, value, ttlDays) => {
      data.set(key, value);
      ttls.set(key, ttlDays);
    },
    del: async (key) => void data.delete(key),
  };
}

/** A fake Reddit that records what Crowd Boot did. */
function fake(karma: Karma, overrides: Partial<Config> = {}, extra: Partial<Deps> = {}) {
  const removed: string[] = [];
  const bans: BanRequest[] = [];
  const logs: string[] = [];
  const store = memoryStore();
  /** Reddit's mod notes, each written as "username: text". */
  const notes: string[] = [];
  const notesOn = (user: string): string[] =>
    notes
      .filter((entry) => entry.toLowerCase().startsWith(`${user.toLowerCase()}: `))
      .map((entry) => entry.slice(user.length + 2));
  /** A clock the test controls. */
  let time = START;
  const wait = (ms: number) => void (time += ms);
  /** Simulates a moderator (or the app itself) doing something in the subreddit. */
  const writeNote: ModActionDeps['addModNote'] = async (_sub, user, note) => void notes.push(`${user}: ${note}`);
  const modAction = (
    action: string,
    moderatorName: string,
    target: { user?: string; comment?: string },
    broken: Partial<ModActionDeps> = {}
  ) =>
    processModAction(
      {
        action,
        moderatorName,
        subredditName: 'testsub',
        targetUserName: target.user ?? '',
        targetCommentId: target.comment ?? '',
      },
      { ...deps, ...broken }
    );
  const deps: Deps = {
    store,
    getConfig: async () => ({ ...DEFAULT_CONFIG, ...overrides }),
    getModNotes: async (_sub, user) => notesOn(user),
    addModNote: writeNote,
    getKarma: async () => karma,
    isModerator: async () => false,
    isApproved: async () => false,
    removeComment: async (id) => void removed.push(id),
    banUser: async (request) => void bans.push(request),
    appUsername: 'crowd-boot',
    now: () => time,
    log: (message) => void logs.push(message),
    ...extra,
  };
  return { deps, removed, bans, logs, store, notes, modAction, wait };
}

const START = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

const NEXT_EVENT = { ...EVENT, commentId: 't1_next' };

test('after a moderator unbans a user Crowd Boot banned, it never bans them again', async () => {
  const f = fake({ fromComments: -99 });
  await processComment(EVENT, f.deps);
  assert.equal(f.bans.length, 1);

  assert.equal(await f.modAction('unbanuser', 'HumanMod', { user: 'someuser' }), 'keep unbanned');
  assert.match(f.notes.join('\n'), /SomeUser|someuser/);
  assert.match(f.notes.join('\n'), /no longer ban this user: unbanned by u\/HumanMod/);

  const outcome = await processComment(NEXT_EVENT, f.deps);
  assert.equal(outcome.banned, false);
  assert.equal(f.bans.length, 1, 'no second ban');
  assert.equal(outcome.removed, true, 'comments are still removed: that is a separate override');
});

test('after a moderator approves a comment Crowd Boot removed, it stops removing that user', async () => {
  const f = fake({ fromComments: -5 });
  await processComment(EVENT, f.deps);
  assert.deepEqual(f.removed, ['t1_abc']);

  assert.equal(await f.modAction('approvecomment', 'HumanMod', { comment: 't1_abc' }), 'keep comments');

  const outcome = await processComment(NEXT_EVENT, f.deps);
  assert.equal(outcome.skipped, 'moderator override');
  assert.deepEqual(f.removed, ['t1_abc'], 'no second removal');
});

test('a user with both overrides is left alone completely', async () => {
  const f = fake({ fromComments: -99 });
  await processComment(EVENT, f.deps);
  await f.modAction('unbanuser', 'HumanMod', { user: 'SomeUser' });
  await f.modAction('approvecomment', 'HumanMod', { comment: 't1_abc' });

  const outcome = await processComment(NEXT_EVENT, f.deps);
  assert.deepEqual([outcome.removed, outcome.banned, outcome.skipped], [false, false, 'moderator override']);
});

test('unrelated moderator actions change nothing', async () => {
  const f = fake({ fromComments: -99 });

  // Unbanning someone Crowd Boot never banned, approving a comment it never removed.
  assert.equal(await f.modAction('unbanuser', 'HumanMod', { user: 'SomeUser' }), undefined);
  assert.equal(await f.modAction('approvecomment', 'HumanMod', { comment: 't1_other' }), undefined);
  assert.equal(f.store.data.size, 0);

  await processComment(EVENT, f.deps);
  // The app's own actions and other action types are ignored.
  assert.equal(await f.modAction('unbanuser', 'crowd-boot', { user: 'SomeUser' }), undefined);
  assert.equal(await f.modAction('approvecomment', 'Crowd-Boot', { comment: 't1_abc' }), undefined);
  assert.equal(await f.modAction('removecomment', 'HumanMod', { comment: 't1_abc' }), undefined);
  // AutoModerator and Reddit are not people, so their approvals are not overrides.
  assert.equal(await f.modAction('approvecomment', 'AutoModerator', { comment: 't1_abc' }), undefined);
  assert.equal(await f.modAction('unbanuser', 'reddit', { user: 'SomeUser' }), undefined);
  assert.deepEqual(f.notes, []);

  f.wait(HOUR);
  const outcome = await processComment(NEXT_EVENT, f.deps);
  assert.deepEqual([outcome.removed, outcome.banned], [true, true]);
});

test('the only things stored are short-lived records of its own actions, never karma', async () => {
  const f = fake({ fromComments: -99 });
  await processComment(EVENT, f.deps);
  assert.deepEqual([...f.store.data.entries()].sort(), [
    ['banned:someuser', String(START)],
    ['removed:t1_abc', 'SomeUser'],
  ]);
  assert.deepEqual([...f.store.ttls.values()], [30, 30], 'every record expires within 30 days');

  // Once a moderator reverses them, the override lives in Reddit's mod notes and
  // nothing about the user is left in the app's storage.
  await f.modAction('unbanuser', 'HumanMod', { user: 'SomeUser' });
  await f.modAction('approvecomment', 'HumanMod', { comment: 't1_abc' });
  assert.equal(f.store.data.size, 0);
  assert.equal(f.notes.length, 2);
});

test('a moderator can write the override note by hand, and deleting it ends the override', async () => {
  const f = fake({ fromComments: -99 });
  f.notes.push('someuser:   crowd boot will no longer ban this user (appeal accepted)');
  const spared = await processComment(EVENT, f.deps);
  assert.deepEqual([spared.removed, spared.banned], [true, false]);

  f.notes.length = 0;
  const outcome = await processComment(NEXT_EVENT, f.deps);
  assert.deepEqual([outcome.removed, outcome.banned], [true, true]);
});

test('notes about other things, or other users, are not overrides', async () => {
  const f = fake({ fromComments: -99 });
  f.notes.push('SomeUser: Warned for rule 2. Crowd Boot will no longer ban this user is not how this starts');
  f.notes.push('OtherUser: Crowd Boot will no longer ban this user: unbanned by u/HumanMod.');
  const outcome = await processComment(EVENT, f.deps);
  assert.deepEqual([outcome.removed, outcome.banned], [true, true]);
});

test('if the mod notes cannot be read, nothing is done', async () => {
  const f = fake({ fromComments: -99 }, {}, {
    getModNotes: async () => {
      throw new Error('reddit is down');
    },
  });
  await assert.rejects(processComment(EVENT, f.deps), /reddit is down/);
  assert.deepEqual([f.removed, f.bans], [[], []]);
});

test('if the override note cannot be written, the reversal can still be recognised later', async () => {
  const f = fake({ fromComments: -99 });
  await processComment(EVENT, f.deps);
  const down = async () => {
    throw new Error('reddit is down');
  };
  await assert.rejects(f.modAction('unbanuser', 'HumanMod', { user: 'SomeUser' }, { addModNote: down }));
  assert.ok(f.store.data.has('banned:someuser'), 'the record of the ban is kept');
  assert.equal(await f.modAction('unbanuser', 'HumanMod', { user: 'SomeUser' }), 'keep unbanned');
});

test('approving several removed comments leaves one note, so deleting it ends the override', async () => {
  const f = fake({ fromComments: -5 });
  const ids = ['t1_one', 't1_two', 't1_three'];
  for (const commentId of ids) await processComment({ ...EVENT, commentId }, f.deps);
  assert.deepEqual(f.removed, ids);

  for (const comment of ids) {
    assert.equal(await f.modAction('approvecomment', 'HumanMod', { comment }), 'keep comments');
  }
  assert.equal(f.notes.length, 1);
  assert.equal(f.store.data.size, 0, 'every removal record is cleared');

  f.notes.length = 0;
  const outcome = await processComment(NEXT_EVENT, f.deps);
  assert.equal(outcome.removed, true);
});

test('an unban adds its own note even when a removal override already exists', async () => {
  const f = fake({ fromComments: -99 });
  await processComment(EVENT, f.deps);
  await f.modAction('approvecomment', 'HumanMod', { comment: 't1_abc' });
  await f.modAction('unbanuser', 'HumanMod', { user: 'SomeUser' });
  assert.equal(f.notes.length, 2);
});

test('the override note is still written when the existing notes cannot be read', async () => {
  const f = fake({ fromComments: -99 });
  await processComment(EVENT, f.deps);
  const down = async () => {
    throw new Error('reddit is down');
  };
  assert.equal(
    await f.modAction('unbanuser', 'HumanMod', { user: 'SomeUser' }, { getModNotes: down }),
    'keep unbanned'
  );
  assert.equal(f.notes.length, 1);
});

test('a hand-typed override counts despite curly apostrophes, capitals and extra spaces', async () => {
  const f = fake({ fromComments: -5 });
  f.notes.push('SomeUser:  CROWD BOOT  will no longer remove this user’s comments');
  const outcome = await processComment(EVENT, f.deps);
  assert.equal(outcome.skipped, 'moderator override');
});

test('a second comment moments after a ban is removed but does not ban again', async () => {
  const f = fake({ fromComments: -99 });
  await processComment(EVENT, f.deps);

  f.wait(5_000);
  const second = await processComment(NEXT_EVENT, f.deps);
  assert.deepEqual([second.removed, second.banned], [true, false]);
  assert.equal(f.bans.length, 1, 'one ban, one ban message');

  // Much later (for example after a temporary ban ran out) the user can be banned again.
  f.wait(HOUR);
  const later = await processComment({ ...EVENT, commentId: 't1_later' }, f.deps);
  assert.equal(later.banned, true);
  assert.equal(f.bans.length, 2);
});

test('a ban recorded by an older version does not block a new ban', async () => {
  const f = fake({ fromComments: -99 });
  f.store.data.set('banned:someuser', '1');
  const outcome = await processComment(EVENT, f.deps);
  assert.equal(outcome.banned, true);
});

test('an over-long ban message is cut to what Reddit accepts', async () => {
  const f = fake({ fromComments: -99 }, { banMessage: 'x'.repeat(5000) });
  await processComment(EVENT, f.deps);
  assert.equal(f.bans[0]!.message.length, 1000);
});

test('unknown placeholders in the ban message are left as written', async () => {
  const f = fake({ fromComments: -99 }, { banMessage: '{username} {toString} {nope}' });
  await processComment(EVENT, f.deps);
  assert.equal(f.bans[0]!.message, 'SomeUser {toString} {nope}');
});

test('a storage failure never blocks or undoes an action', async () => {
  const broken: Store = {
    get: async () => undefined,
    set: async () => {
      throw new Error('storage down');
    },
    del: async () => {},
  };
  const f = fake({ fromComments: -99 }, {}, { store: broken });
  const outcome = await processComment(EVENT, f.deps);
  assert.deepEqual([outcome.removed, outcome.banned], [true, true]);
  assert.match(f.logs.join('\n'), /could not record/);
});

test('a user Reddit has no karma on record for is treated as 0 and left alone', async () => {
  const f = fake({}, {}, { getKarma: async () => undefined });
  const outcome = await processComment(EVENT, f.deps);
  assert.deepEqual([outcome.karma, outcome.removed, outcome.banned], [0, false, false]);
  assert.deepEqual(f.logs, [], 'nothing is logged when nothing is done');
});

test('a ban also removes the comment when the checkpoints are the wrong way round', async () => {
  const inverted = { removeBelow: -10, banBelow: -5 };
  const f = fake({ fromComments: -7 }, inverted);
  const outcome = await processComment(EVENT, f.deps);
  assert.deepEqual([outcome.removed, outcome.banned], [true, true]);

  // Once a moderator has unbanned them, -7 is above the removal checkpoint again.
  await f.modAction('unbanuser', 'HumanMod', { user: 'SomeUser' });
  const next = await processComment(NEXT_EVENT, f.deps);
  assert.deepEqual([next.removed, next.banned, next.skipped], [false, false, 'moderator override']);
});

test('the record of a ban lapses with a short ban, and never outlives 30 days', async () => {
  const short = fake({ fromComments: -99 }, { banDurationDays: 7 });
  await processComment(EVENT, short.deps);
  assert.equal(short.store.ttls.get('banned:someuser'), 7);

  const long = fake({ fromComments: -99 }, { banDurationDays: 90 });
  await processComment(EVENT, long.deps);
  assert.equal(long.store.ttls.get('banned:someuser'), 30);

  const permanent = fake({ fromComments: -99 });
  await processComment(EVENT, permanent.deps);
  assert.equal(permanent.store.ttls.get('banned:someuser'), 30);
  assert.equal(permanent.store.ttls.get('removed:t1_abc'), 30);
});

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

test('when the author deletes a removed comment, the record of it is dropped at once', async () => {
  const f = fake({ fromComments: -5 });
  await processComment(EVENT, f.deps);
  assert.ok(f.store.data.has('removed:t1_abc'));

  assert.equal(await processCommentDelete({ commentId: 't1_abc', source: 'USER' }, f.deps), true);
  assert.equal(f.store.data.size, 0);
  // Nothing is left to recognise, so a later approval changes nothing.
  assert.equal(await f.modAction('approvecomment', 'HumanMod', { comment: 't1_abc' }), undefined);
  assert.deepEqual(f.notes, []);
});

test('a comment deletion is recognised however Reddit spells its source', async () => {
  for (const source of ['USER', 'user', 1, '1', 'ADMIN', 2]) {
    const f = fake({ fromComments: -5 });
    await processComment(EVENT, f.deps);
    // The id may arrive with or without its "t1_" prefix.
    assert.equal(await processCommentDelete({ commentId: 'abc', source }, f.deps), true, String(source));
    assert.equal(f.store.data.size, 0, String(source));
  }
});

test("a moderator's removal is not a deletion, so the record is kept", async () => {
  for (const source of ['MODERATOR', 3, 'UNKNOWN_EVENT_SOURCE', 0, undefined]) {
    const f = fake({ fromComments: -5 });
    await processComment(EVENT, f.deps);
    assert.equal(await processCommentDelete({ commentId: 't1_abc', source }, f.deps), false, String(source));
    assert.ok(f.store.data.has('removed:t1_abc'), String(source));
  }
  // The approval that follows a moderator's removal is still recognised.
  const f = fake({ fromComments: -5 });
  await processComment(EVENT, f.deps);
  await processCommentDelete({ commentId: 't1_abc', source: 'MODERATOR' }, f.deps);
  assert.equal(await f.modAction('approvecomment', 'HumanMod', { comment: 't1_abc' }), 'keep comments');
});

/**
 * Crowd Boot's decision logic. Nothing in this file talks to Reddit directly:
 * everything it needs is passed in as `Deps`, so it can be tested offline.
 */

export type KarmaSource = 'combined' | 'comments';

/**
 * What happens to a low-karma user's comment.
 * - "filter" hides it and sends it to the mod queue for a moderator to review.
 * - "report" leaves it up and flags it in the mod queue.
 * - "remove" hides it without asking anyone.
 * - "none" leaves it alone.
 */
export type CommentAction = 'filter' | 'report' | 'remove' | 'none';

export type Config = {
  karmaSource: KarmaSource;
  commentAction: CommentAction;
  /** Filter or remove the comment when karma is strictly below this. */
  removeBelow: number;
  banEnabled: boolean;
  /** Ban the author when karma is strictly below this. */
  banBelow: number;
  /** 0 = permanent. */
  banDurationDays: number;
  banMessage: string;
  exemptApproved: boolean;
  /** Lower-cased usernames. */
  exemptUsers: Set<string>;
};

export const DEFAULT_BAN_MESSAGE =
  "Hi u/{username}, your karma in r/{subreddit} has dropped to {karma}, which is below this community's limit of {threshold}. You have been banned automatically. If you think this is a mistake please contact the moderators of this subreddit.";

export const DEFAULT_CONFIG: Config = {
  karmaSource: 'combined',
  commentAction: 'filter',
  removeBelow: 0,
  banEnabled: true,
  banBelow: -10,
  banDurationDays: 0,
  banMessage: DEFAULT_BAN_MESSAGE,
  exemptApproved: true,
  exemptUsers: new Set(),
};

/** Reddit's limit for a ban length, in days. */
export const MAX_BAN_DAYS = 999;

/** Reddit rejects a ban whose message is longer than this, so longer ones are cut. */
export const MAX_BAN_MESSAGE = 1000;

/**
 * A second comment can arrive before the first ban has taken effect. For this
 * long after banning someone, Crowd Boot will not ban (and message) them again.
 */
const REBAN_QUIET_MS = 10 * 60 * 1000;

type RawSettings = Record<string, unknown>;

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** Select settings can arrive as a plain string or a one-item array. */
function asChoice(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' ? v : undefined;
}

/**
 * Turns the raw values from the app's settings page into a safe Config.
 * Thresholds are capped at 0 so a typo can never make the app act on users
 * with zero or positive karma (which would hit every newcomer).
 */
export function parseConfig(raw: RawSettings): Config {
  const d = DEFAULT_CONFIG;
  const message = typeof raw.banMessage === 'string' ? raw.banMessage.trim() : '';
  const exempt = typeof raw.exemptUsers === 'string' ? raw.exemptUsers : '';
  const days = Math.trunc(asNumber(raw.banDurationDays, d.banDurationDays));

  return {
    karmaSource: asChoice(raw.karmaSource) === 'comments' ? 'comments' : 'combined',
    commentAction: commentActionFrom(raw),
    removeBelow: Math.min(0, asNumber(raw.removeBelow, d.removeBelow)),
    banEnabled: asBoolean(raw.banEnabled, d.banEnabled),
    banBelow: Math.min(0, asNumber(raw.banBelow, d.banBelow)),
    banDurationDays: Math.min(MAX_BAN_DAYS, Math.max(0, days)),
    banMessage: message || d.banMessage,
    exemptApproved: asBoolean(raw.exemptApproved, d.exemptApproved),
    exemptUsers: new Set(
      exempt
        .split(/[\s,]+/)
        .map((name) => name.replace(/^\/?u\//i, '').toLowerCase())
        .filter(Boolean)
    ),
  };
}

/**
 * Reads the choice from the settings page. Before it was a choice it was a
 * tick; a subreddit that had unticked it keeps its comments left alone.
 */
function commentActionFrom(raw: RawSettings): CommentAction {
  const choice = asChoice(raw.commentAction);
  if (choice === 'filter' || choice === 'report' || choice === 'remove' || choice === 'none') return choice;
  return raw.removeEnabled === false ? 'none' : DEFAULT_CONFIG.commentAction;
}

export type Karma = { fromComments?: number | undefined; fromPosts?: number | undefined };

export function karmaFor(karma: Karma, source: KarmaSource): number {
  const comments = karma.fromComments ?? 0;
  return source === 'comments' ? comments : comments + (karma.fromPosts ?? 0);
}

export function decide(karma: number, config: Config): { remove: boolean; ban: boolean } {
  return {
    remove: config.commentAction !== 'none' && karma < config.removeBelow,
    ban: config.banEnabled && karma < config.banBelow,
  };
}

export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match
  );
}

export type CommentEvent = {
  /** Full comment ID, e.g. "t1_abc123". */
  commentId: string;
  authorName: string;
  subredditName: string;
};

export type BanRequest = {
  username: string;
  subredditName: string;
  /** Shown to mods in the ban list. */
  reason: string;
  /** Private mod note. */
  note: string;
  /** Sent to the banned user. */
  message: string;
  /** The comment that triggered the ban. */
  context: string;
  /** Omitted for a permanent ban. */
  duration?: number;
};

/**
 * Crowd Boot's only memory: the bans and removals it made recently, so that a
 * moderator reversing one can be recognised. Every record needs an expiry, so
 * nothing about a user can be kept for good. It never holds karma or any score.
 */
export type Store = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlDays: number): Promise<void>;
  del(key: string): Promise<void>;
};

const keys = {
  /** Crowd Boot banned this user. The value is when, in milliseconds. */
  banned: (user: string) => `banned:${user.toLowerCase()}`,
  /** Crowd Boot removed this comment. The value is the author's username. */
  removed: (commentId: string) => `removed:${commentId}`,
};

/**
 * How long Crowd Boot remembers one of its own bans or removals. Reddit's rules
 * for apps ask for stored user data to be gone within 30 days.
 */
export const MEMORY_DAYS = 30;

/**
 * A moderator's override is a mod note on the user, kept by Reddit and not by
 * Crowd Boot. Any note that starts with one of these counts, so a moderator can
 * also write one by hand, and deleting the note ends the override.
 */
export const BAN_OVERRIDE = 'Crowd Boot will no longer ban this user';
export const REMOVE_OVERRIDE = "Crowd Boot will no longer remove this user's comments";

/** Reddit's limit for the text of a mod note. */
const MAX_MOD_NOTE = 250;

/** Ignores case, spacing and the curly apostrophes phones insert, so a hand-typed note still counts. */
const plain = (text: string): string =>
  text.trim().toLowerCase().replace(/[‘’ʼ`´]/g, "'").replace(/\s+/g, ' ');

/** Which overrides a user's mod notes contain. */
export function overridesIn(notes: readonly string[]): { ban: boolean; remove: boolean } {
  const has = (marker: string): boolean => notes.some((note) => plain(note).startsWith(plain(marker)));
  return { ban: has(BAN_OVERRIDE), remove: has(REMOVE_OVERRIDE) };
}

export type Deps = {
  store: Store;
  getConfig(): Promise<Config>;
  /** The text of every note moderators have left on this user in this subreddit. */
  getModNotes(subredditName: string, username: string): Promise<string[]>;
  addModNote(subredditName: string, username: string, note: string): Promise<void>;
  /** Resolves to undefined when Reddit has no karma on record for this user here. */
  getKarma(username: string): Promise<Karma | undefined>;
  isModerator(subredditName: string, username: string): Promise<boolean>;
  isApproved(subredditName: string, username: string): Promise<boolean>;
  /** Hides the comment and puts it in the mod queue, showing moderators the reason. */
  filterComment(commentId: string, reason: string): Promise<void>;
  /** Leaves the comment up and flags it in the mod queue, showing moderators the reason. */
  reportComment(commentId: string, reason: string): Promise<void>;
  removeComment(commentId: string, note: string): Promise<void>;
  banUser(request: BanRequest): Promise<void>;
  /** The app's own account name, so it never acts on itself. */
  appUsername?: string | undefined;
  /** The current time in milliseconds. Defaults to the real clock. */
  now?(): number;
  log(message: string): void;
};

export type Outcome = {
  /** Why nothing was checked, if the author was skipped. */
  skipped?: string;
  karma?: number;
  /** The comment was taken down: removed, or filtered into the mod queue. */
  removed: boolean;
  /** The comment was left up and flagged in the mod queue. */
  reported: boolean;
  banned: boolean;
};

const NOTHING = { removed: false, reported: false, banned: false };
const SYSTEM_ACCOUNTS = new Set(['automoderator', '[deleted]', 'reddit']);

export async function processComment(event: CommentEvent, deps: Deps): Promise<Outcome> {
  const { commentId, authorName, subredditName } = event;
  const author = authorName.toLowerCase();

  if (!commentId || !author || !subredditName) return { ...NOTHING, skipped: 'incomplete event' };
  if (SYSTEM_ACCOUNTS.has(author) || author === deps.appUsername?.toLowerCase()) {
    return { ...NOTHING, skipped: 'system account' };
  }

  const config = await deps.getConfig();
  if (config.commentAction === 'none' && !config.banEnabled) return { ...NOTHING, skipped: 'app disabled' };
  if (config.exemptUsers.has(author)) return { ...NOTHING, skipped: 'exempt user' };

  // Karma first: almost everyone is above the limit, so most comments stop here
  // after a single API call.
  // No karma on record means the user has not earned any here yet: count it as 0.
  const karma = karmaFor((await deps.getKarma(authorName)) ?? {}, config.karmaSource);
  const decision = decide(karma, config);
  // Nothing is logged when nothing is done.
  if (!decision.remove && !decision.ban) return { ...NOTHING, karma };

  // A moderator who reversed an earlier Crowd Boot action has the final say.
  const override = overridesIn(await deps.getModNotes(subredditName, authorName));
  if (override.ban) decision.ban = false;
  // A ban always takes the comment with it, even if the two checkpoints were
  // entered the wrong way round (ban checkpoint above the removal checkpoint).
  if (decision.ban && config.commentAction !== 'none') decision.remove = true;
  if (override.remove) decision.remove = false;
  if (!decision.remove && !decision.ban) {
    return { ...NOTHING, karma, skipped: 'moderator override' };
  }

  if (await deps.isModerator(subredditName, authorName)) {
    return { ...NOTHING, karma, skipped: 'moderator' };
  }
  if (config.exemptApproved && (await deps.isApproved(subredditName, authorName))) {
    return { ...NOTHING, karma, skipped: 'approved user' };
  }

  const who = `u/${authorName} (subreddit karma ${karma})`;
  // Deal with the comment and ban independently, so a failure in one doesn't block the other.
  let removed = false;
  let reported = false;
  if (decision.remove) {
    const limit = decision.ban ? Math.max(config.removeBelow, config.banBelow) : config.removeBelow;
    const why = `Crowd Boot: subreddit karma ${karma} is below ${limit}`;
    try {
      if (config.commentAction === 'report') {
        // The comment stays up and a moderator decides. Approving it in the
        // queue is an ordinary review, so nothing is recorded for it.
        await deps.reportComment(commentId, why);
        deps.log(`reported comment ${commentId} by ${who}`);
        reported = true;
      } else if (config.commentAction === 'filter' && (await filtered(deps, commentId, why, who))) {
        // A filtered comment waits in the mod queue. Approving it there is an
        // ordinary review of that one comment, so nothing is recorded for it.
        removed = true;
      } else {
        await deps.removeComment(commentId, why);
        deps.log(`removed comment ${commentId} by ${who}`);
        // Only a removal made on purpose is remembered, so that a moderator
        // reversing it can be recognised.
        if (config.commentAction === 'remove') {
          await remember(deps, keys.removed(commentId), authorName, MEMORY_DAYS);
        }
        removed = true;
      }
    } catch (error) {
      const verb = config.commentAction === 'report' ? 'report' : 'remove';
      deps.log(`FAILED to ${verb} comment ${commentId} by ${who}: ${String(error)}`);
    }
  }

  let banned = false;
  const now = deps.now?.() ?? Date.now();
  if (decision.ban && !(await bannedMomentsAgo(deps, author, now))) {
    const request: BanRequest = {
      username: authorName,
      subredditName,
      reason: 'Low subreddit karma (Crowd Boot)',
      note: `Crowd Boot: subreddit karma ${karma} is below ${config.banBelow}`,
      message: fillTemplate(config.banMessage, {
        username: authorName,
        subreddit: subredditName,
        karma,
        threshold: config.banBelow,
      }).slice(0, MAX_BAN_MESSAGE),
      context: commentId,
    };
    if (config.banDurationDays > 0) request.duration = config.banDurationDays;

    try {
      await deps.banUser(request);
      banned = true;
      deps.log(`banned ${who}`);
      // A temporary ban that runs out on its own was not reversed by anyone, so
      // the record of it lapses with the ban, and never outlives MEMORY_DAYS.
      const days = Math.min(config.banDurationDays || MEMORY_DAYS, MEMORY_DAYS);
      await remember(deps, keys.banned(author), String(now), days);
    } catch (error) {
      deps.log(`FAILED to ban ${who}: ${String(error)}`);
    }
  }

  return { karma, removed, reported, banned };
}

/**
 * Puts the comment in the mod queue. Returns false, without throwing, if Reddit
 * refuses: filtering is a newer part of Reddit, and removing the comment is
 * better than leaving a low-karma comment up.
 */
async function filtered(deps: Deps, commentId: string, why: string, who: string): Promise<boolean> {
  try {
    await deps.filterComment(commentId, why);
    deps.log(`filtered comment ${commentId} by ${who}`);
    return true;
  } catch (error) {
    deps.log(`could not filter comment ${commentId} by ${who}, removing it instead: ${String(error)}`);
    return false;
  }
}

/** True if Crowd Boot banned this user within the last few minutes. Never throws. */
async function bannedMomentsAgo(deps: Deps, author: string, now: number): Promise<boolean> {
  try {
    // A missing record gives NaN, and any comparison with NaN is false.
    return now - Number(await deps.store.get(keys.banned(author))) < REBAN_QUIET_MS;
  } catch {
    return false;
  }
}

/** Records an action so a later reversal by a moderator can be recognised. Never throws. */
async function remember(deps: Deps, key: string, value: string, ttlDays: number): Promise<void> {
  try {
    await deps.store.set(key, value, ttlDays);
  } catch (error) {
    deps.log(`could not record ${key}: ${String(error)}`);
  }
}

export type ModActionEvent = {
  /** Reddit's name for the action, e.g. "unbanuser" or "approvecomment". */
  action: string;
  moderatorName: string;
  subredditName: string;
  targetUserName: string;
  targetCommentId: string;
};

/** The part of Deps the handler for moderator actions needs. */
export type ModActionDeps = Pick<Deps, 'store' | 'appUsername' | 'getModNotes' | 'addModNote' | 'log'>;

/**
 * Watches for a moderator undoing something Crowd Boot did, and records it as
 * a mod note on the user. From then on Crowd Boot leaves that user alone for
 * that kind of action. If the note cannot be written this throws, and the
 * record of the action is kept.
 */
export async function processModAction(
  event: ModActionEvent,
  deps: ModActionDeps
): Promise<'keep unbanned' | 'keep comments' | undefined> {
  const moderator = event.moderatorName;
  // Crowd Boot's own removals and bans arrive here too, and so do AutoModerator's
  // and Reddit's. Only people count.
  const who = moderator.toLowerCase();
  if (!who || SYSTEM_ACCOUNTS.has(who) || who === deps.appUsername?.toLowerCase()) return undefined;

  if (event.action === 'unbanuser') {
    const user = event.targetUserName;
    if (!user || !(await deps.store.get(keys.banned(user)))) return undefined;
    const note = `${BAN_OVERRIDE}: unbanned by u/${moderator}.`;
    await recordOverride(deps, event.subredditName, user, 'ban', note);
    await deps.store.del(keys.banned(user));
    deps.log(`u/${moderator} unbanned u/${user}: will not ban this user again`);
    return 'keep unbanned';
  }

  if (event.action === 'approvecomment') {
    const commentId = event.targetCommentId;
    const author = commentId ? await deps.store.get(keys.removed(commentId)) : undefined;
    if (!author) return undefined;
    const note = `${REMOVE_OVERRIDE}: u/${moderator} approved one it removed.`;
    await recordOverride(deps, event.subredditName, author, 'remove', note);
    await deps.store.del(keys.removed(commentId));
    deps.log(`u/${moderator} approved a removed comment by u/${author}: will not remove again`);
    return 'keep comments';
  }

  return undefined;
}

export type CommentDeleteEvent = {
  commentId: string;
  /** Who deleted it, as Reddit reports it: a name such as "USER" or its number. */
  source: unknown;
};

/**
 * Reddit says a comment was deleted. If its author or Reddit itself deleted
 * it, nobody can approve it any more, so the record that Crowd Boot removed it
 * is dropped at once. A moderator's removal (Crowd Boot's own included) also
 * arrives here, with source 3, and is not a deletion: that record is still
 * needed to recognise an approval.
 *
 * Seen live in November 2026: Reddit does not send this event when an author
 * deletes a comment a moderator had already removed, which is every comment
 * Crowd Boot holds a record for. Until Reddit fixes that, the expiry on each
 * record (MEMORY_DAYS) is what really clears it.
 */
export async function processCommentDelete(
  event: CommentDeleteEvent,
  deps: Pick<Deps, 'store'>
): Promise<boolean> {
  const source = String(event.source).toUpperCase();
  const goneForGood = ['USER', 'ADMIN', '1', '2'].includes(source);
  if (!event.commentId || !goneForGood) return false;
  const id = event.commentId.startsWith('t1_') ? event.commentId : `t1_${event.commentId}`;
  await deps.store.del(keys.removed(id));
  return true;
}

/**
 * Writes the mod note that is the override, unless the user already has one.
 * A moderator approving several removed comments then leaves a single note,
 * so deleting that one note is enough to end the override.
 */
async function recordOverride(
  deps: ModActionDeps,
  subredditName: string,
  username: string,
  kind: 'ban' | 'remove',
  note: string
): Promise<void> {
  let existing: string[] = [];
  try {
    existing = await deps.getModNotes(subredditName, username);
  } catch {
    // Write it anyway: a second note is better than a lost override.
  }
  if (overridesIn(existing)[kind]) return;
  await deps.addModNote(subredditName, username, note.slice(0, MAX_MOD_NOTE));
}

/** Shared by the settings-page validators. Returns an error message, or undefined if valid. */
export function thresholdError(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'Enter a whole number.';
  if (value > 0) return 'Must be 0 or lower. 0 means "any negative karma".';
  return undefined;
}

export function durationError(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'Enter a whole number of days.';
  if (value < 0 || value > MAX_BAN_DAYS) return `Must be between 0 (permanent) and ${MAX_BAN_DAYS}.`;
  return undefined;
}

/**
 * Crowd Boot's decision logic. Nothing in this file talks to Reddit directly:
 * everything it needs is passed in as `Deps`, so it can be tested offline.
 */

export type KarmaSource = 'combined' | 'comments';

export type Config = {
  karmaSource: KarmaSource;
  removeEnabled: boolean;
  /** Remove the comment when karma is strictly below this. */
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
  removeEnabled: true,
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
    removeEnabled: asBoolean(raw.removeEnabled, d.removeEnabled),
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

export type Karma = { fromComments?: number | undefined; fromPosts?: number | undefined };

export function karmaFor(karma: Karma, source: KarmaSource): number {
  const comments = karma.fromComments ?? 0;
  return source === 'comments' ? comments : comments + (karma.fromPosts ?? 0);
}

export function decide(karma: number, config: Config): { remove: boolean; ban: boolean } {
  return {
    remove: config.removeEnabled && karma < config.removeBelow,
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
 * Crowd Boot's only memory: which actions it took, and which of those a
 * moderator later reversed. It never holds karma or any score of its own.
 */
export type Store = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlDays?: number): Promise<void>;
  del(key: string): Promise<void>;
};

const keys = {
  /** Crowd Boot banned this user. The value is when, in milliseconds. */
  banned: (user: string) => `banned:${user.toLowerCase()}`,
  /** Crowd Boot removed this comment. The value is the author's username. */
  removed: (commentId: string) => `removed:${commentId}`,
  /** A moderator unbanned this user after a Crowd Boot ban: never ban again. */
  keepUnbanned: (user: string) => `pardon:ban:${user.toLowerCase()}`,
  /** A moderator approved a comment Crowd Boot removed: never remove again. */
  keepComments: (user: string) => `pardon:remove:${user.toLowerCase()}`,
};

/** How long Crowd Boot remembers that it removed a particular comment. */
const REMOVED_MEMORY_DAYS = 90;

export type Deps = {
  store: Store;
  getConfig(): Promise<Config>;
  /** Resolves to undefined when Reddit has no karma on record for this user here. */
  getKarma(username: string): Promise<Karma | undefined>;
  isModerator(subredditName: string, username: string): Promise<boolean>;
  isApproved(subredditName: string, username: string): Promise<boolean>;
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
  removed: boolean;
  banned: boolean;
};

const NOTHING = { removed: false, banned: false };
const SYSTEM_ACCOUNTS = new Set(['automoderator', '[deleted]', 'reddit']);

export async function processComment(event: CommentEvent, deps: Deps): Promise<Outcome> {
  const { commentId, authorName, subredditName } = event;
  const author = authorName.toLowerCase();

  if (!commentId || !author || !subredditName) return { ...NOTHING, skipped: 'incomplete event' };
  if (SYSTEM_ACCOUNTS.has(author) || author === deps.appUsername?.toLowerCase()) {
    return { ...NOTHING, skipped: 'system account' };
  }

  const config = await deps.getConfig();
  if (!config.removeEnabled && !config.banEnabled) return { ...NOTHING, skipped: 'app disabled' };
  if (config.exemptUsers.has(author)) return { ...NOTHING, skipped: 'exempt user' };

  // Karma first: almost everyone is above the limit, so most comments stop here
  // after a single API call.
  // No karma on record means the user has not earned any here yet: count it as 0.
  const karma = karmaFor((await deps.getKarma(authorName)) ?? {}, config.karmaSource);
  const decision = decide(karma, config);
  // Nothing is logged when nothing is done.
  if (!decision.remove && !decision.ban) return { ...NOTHING, karma };

  // A moderator who reversed an earlier Crowd Boot action has the final say.
  if (decision.ban && (await deps.store.get(keys.keepUnbanned(author)))) decision.ban = false;
  // A ban always takes the comment with it, even if the two checkpoints were
  // entered the wrong way round (ban checkpoint above the removal checkpoint).
  if (decision.ban && config.removeEnabled) decision.remove = true;
  if (decision.remove && (await deps.store.get(keys.keepComments(author)))) decision.remove = false;
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
  // Remove and ban independently, so a failure in one doesn't block the other.
  let removed = false;
  if (decision.remove) {
    const limit = decision.ban ? Math.max(config.removeBelow, config.banBelow) : config.removeBelow;
    try {
      await deps.removeComment(commentId, `Crowd Boot: subreddit karma ${karma} is below ${limit}`);
      removed = true;
      deps.log(`removed comment ${commentId} by ${who}`);
      await remember(deps, keys.removed(commentId), authorName, REMOVED_MEMORY_DAYS);
    } catch (error) {
      deps.log(`FAILED to remove comment ${commentId} by ${who}: ${String(error)}`);
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
      // the record of it lapses with the ban.
      await remember(deps, keys.banned(author), String(now), config.banDurationDays || undefined);
    } catch (error) {
      deps.log(`FAILED to ban ${who}: ${String(error)}`);
    }
  }

  return { karma, removed, banned };
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
async function remember(deps: Deps, key: string, value: string, ttlDays?: number): Promise<void> {
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

export type ModActionDeps = {
  store: Store;
  appUsername?: string | undefined;
  addModNote(subredditName: string, username: string, note: string): Promise<void>;
  log(message: string): void;
};

/**
 * Watches for a moderator undoing something Crowd Boot did. From then on Crowd
 * Boot leaves that user alone for that kind of action.
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
    await deps.store.set(keys.keepUnbanned(user), moderator);
    await deps.store.del(keys.banned(user));
    deps.log(`u/${moderator} unbanned u/${user}: will not ban this user again`);
    await explain(
      event.subredditName,
      user,
      `Crowd Boot will no longer ban this user: unbanned by u/${moderator}.`,
      deps
    );
    return 'keep unbanned';
  }

  if (event.action === 'approvecomment') {
    const commentId = event.targetCommentId;
    const author = commentId ? await deps.store.get(keys.removed(commentId)) : undefined;
    if (!author) return undefined;
    await deps.store.set(keys.keepComments(author), moderator);
    await deps.store.del(keys.removed(commentId));
    deps.log(`u/${moderator} approved a removed comment by u/${author}: will not remove again`);
    await explain(
      event.subredditName,
      author,
      `Crowd Boot will no longer remove this user's comments: u/${moderator} approved one it removed.`,
      deps
    );
    return 'keep comments';
  }

  return undefined;
}

/** Leaves a mod note so other moderators can see why Crowd Boot stopped acting. Never throws. */
async function explain(
  subredditName: string,
  username: string,
  note: string,
  deps: ModActionDeps
): Promise<void> {
  try {
    await deps.addModNote(subredditName, username, note.slice(0, 250));
  } catch (error) {
    deps.log(`could not add mod note for u/${username}: ${String(error)}`);
  }
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

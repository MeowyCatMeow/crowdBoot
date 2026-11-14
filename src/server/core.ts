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
    key in values ? String(values[key]) : match
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

export type Deps = {
  getConfig(): Promise<Config>;
  getKarma(username: string): Promise<Karma>;
  isModerator(subredditName: string, username: string): Promise<boolean>;
  isApproved(subredditName: string, username: string): Promise<boolean>;
  removeComment(commentId: string, note: string): Promise<void>;
  banUser(request: BanRequest): Promise<void>;
  /** The app's own account name, so it never acts on itself. */
  appUsername?: string | undefined;
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
  const karma = karmaFor(await deps.getKarma(authorName), config.karmaSource);
  const decision = decide(karma, config);
  if (!decision.remove && !decision.ban) return { ...NOTHING, karma };

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
    try {
      await deps.removeComment(
        commentId,
        `Crowd Boot: subreddit karma ${karma} is below ${config.removeBelow}`
      );
      removed = true;
      deps.log(`removed comment ${commentId} by ${who}`);
    } catch (error) {
      deps.log(`FAILED to remove comment ${commentId} by ${who}: ${String(error)}`);
    }
  }

  let banned = false;
  if (decision.ban) {
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
      }),
      context: commentId,
    };
    if (config.banDurationDays > 0) request.duration = config.banDurationDays;

    try {
      await deps.banUser(request);
      banned = true;
      deps.log(`banned ${who}`);
    } catch (error) {
      deps.log(`FAILED to ban ${who}: ${String(error)}`);
    }
  }

  return { karma, removed, banned };
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

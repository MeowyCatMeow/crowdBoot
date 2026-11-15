import {
  context,
  createServer,
  getServerPort,
  reddit,
  redis,
  settings,
} from '@devvit/web/server';
import type {
  OnCommentCreateRequest,
  OnModActionRequest,
  SettingsValidationRequest,
  SettingsValidationResponse,
  TriggerResponse,
} from '@devvit/web/shared';
import express from 'express';

import {
  type Deps,
  durationError,
  parseConfig,
  processComment,
  processModAction,
  type Store,
  thresholdError,
} from './core.ts';

const log = (message: string): void => console.log(`[crowd-boot] ${message}`);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Crowd Boot's memory of its own actions and moderator reversals, kept per subreddit. */
const store: Store = {
  get: (key) => redis.get(key),
  set: async (key, value, ttlDays) => {
    const options = ttlDays ? { expiration: new Date(Date.now() + ttlDays * DAY_MS) } : undefined;
    await redis.set(key, value, options);
  },
  del: (key) => redis.del(key),
};

/** Connects the decision logic in core.ts to the real Reddit API. */
const deps: Deps = {
  log,
  store,
  get appUsername() {
    return context.appSlug;
  },
  getConfig: async () => parseConfig(await settings.getAll<Record<string, unknown>>()),
  getKarma: async (username) => {
    try {
      return await reddit.getUserKarmaFromCurrentSubreddit(username);
    } catch (error) {
      // Reddit answers "not found" for someone who has no karma in this subreddit yet.
      if (/NOT_FOUND/.test(String(error))) return undefined;
      throw error;
    }
  },
  isModerator: async (subredditName, username) =>
    (await reddit.getModerators({ subredditName, username }).all()).length > 0,
  isApproved: async (subredditName, username) =>
    (await reddit.getApprovedUsers({ subredditName, username }).all()).length > 0,
  removeComment: async (commentId, note) => {
    await reddit.remove(commentId as `t1_${string}`, false);
    try {
      // Shows mods why it was removed. Not essential, so never fail the removal over it.
      await reddit.addRemovalNote({ itemIds: [commentId], reasonId: '', modNote: note.slice(0, 100) });
    } catch (error) {
      log(`could not add removal note to ${commentId}: ${String(error)}`);
    }
  },
  banUser: (request) => reddit.banUser(request),
};

const app = express();
app.use(express.json());

app.post<unknown, TriggerResponse, OnCommentCreateRequest>(
  '/internal/triggers/comment-create',
  async (req, res) => {
    const { comment, author, subreddit } = req.body;
    try {
      await processComment(
        {
          commentId: comment?.id ?? '',
          authorName: author?.name ?? comment?.author ?? '',
          subredditName: subreddit?.name ?? context.subredditName ?? '',
        },
        deps
      );
    } catch (error) {
      // Fail open: if anything goes wrong, leave the comment and user alone.
      log(`error handling comment ${comment?.id ?? '(unknown)'}: ${String(error)}`);
    }
    res.json({});
  }
);

app.post<unknown, TriggerResponse, OnModActionRequest>(
  '/internal/triggers/mod-action',
  async (req, res) => {
    const { action, moderator, subreddit, targetUser, targetComment } = req.body;
    try {
      await processModAction(
        {
          action: action ?? '',
          moderatorName: moderator?.name ?? '',
          subredditName: subreddit?.name ?? context.subredditName ?? '',
          targetUserName: targetUser?.name ?? '',
          targetCommentId: targetComment?.id ?? '',
        },
        {
          store,
          log,
          appUsername: context.appSlug,
          addModNote: async (subredditName, username, note) => {
            await reddit.addModNote({ subreddit: subredditName, user: username, note });
          },
        }
      );
    } catch (error) {
      log(`error handling mod action ${action ?? '(unknown)'}: ${String(error)}`);
    }
    res.json({});
  }
);

function validator(check: (value: unknown) => string | undefined) {
  return (
    req: express.Request<unknown, SettingsValidationResponse, SettingsValidationRequest<number>>,
    res: express.Response<SettingsValidationResponse>
  ): void => {
    const error = check(req.body.value);
    res.json(error ? { success: false, error } : { success: true });
  };
}

app.post('/internal/settings/validate-threshold', validator(thresholdError));
app.post('/internal/settings/validate-duration', validator(durationError));

createServer(app).listen(getServerPort());

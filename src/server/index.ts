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
  OnCommentDeleteRequest,
  OnCommentUpdateRequest,
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
  processCommentDelete,
  processModAction,
  type Store,
  thresholdError,
} from './core.ts';

const log = (message: string): void => console.log(`[crowd-boot] ${message}`);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Crowd Boot's short memory of its own bans and removals, kept per subreddit. */
const store: Store = {
  get: (key) => redis.get(key),
  // Every record expires: nothing about a user is ever stored for good.
  set: async (key, value, ttlDays) => {
    await redis.set(key, value, { expiration: new Date(Date.now() + ttlDays * DAY_MS) });
  },
  del: (key) => redis.del(key),
};

const named = (username: string) => (user: { username: string }) =>
  user.username.toLowerCase() === username.toLowerCase();

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
  // Overrides live in Reddit's own mod notes, so Reddit looks after that data.
  getModNotes: async (subredditName, username) =>
    (await reddit.getModNotes({ subreddit: subredditName, user: username, filter: 'NOTE' }).all()).map(
      (note) => note.userNote?.note ?? ''
    ),
  addModNote: async (subredditName, username, note) => {
    await reddit.addModNote({ subreddit: subredditName, user: username, note });
  },
  // Reddit is asked for this one user, and the answer is still checked by name,
  // so a wider list than expected can never make everyone look exempt.
  isModerator: async (subredditName, username) =>
    (await reddit.getModerators({ subredditName, username }).all()).some(named(username)),
  isApproved: async (subredditName, username) =>
    (await reddit.getApprovedUsers({ subredditName, username }).all()).some(named(username)),
  filterComment: async (commentId, reason) => {
    await reddit.filter(commentId as `t1_${string}`, { reason });
  },
  reportComment: async (commentId, reason) => {
    const comment = await reddit.getCommentById(commentId as `t1_${string}`);
    // Reddit allows a report reason of up to 100 characters.
    await reddit.report(comment, { reason: reason.slice(0, 100) });
  },
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
// A comment event carries its whole parent post, which can exceed the 100 KB default.
app.use(express.json({ limit: '10mb' }));

/** Runs the karma check for a comment that was just posted or just edited. */
async function check(body: OnCommentCreateRequest | OnCommentUpdateRequest, edited: boolean): Promise<void> {
  const { comment, author, subreddit } = body;
  try {
    await processComment(
      {
        commentId: comment?.id ?? '',
        authorName: author?.name ?? comment?.author ?? '',
        subredditName: subreddit?.name ?? context.subredditName ?? '',
        edited,
      },
      deps
    );
  } catch (error) {
    // Fail open: if anything goes wrong, leave the comment and user alone.
    log(`error handling comment ${comment?.id ?? '(unknown)'}: ${String(error)}`);
  }
}

app.post<unknown, TriggerResponse, OnCommentCreateRequest>(
  '/internal/triggers/comment-create',
  async (req, res) => {
    await check(req.body, false);
    res.json({});
  }
);

// An edited comment is checked like a new one, so nobody can get a comment
// past the moderators and then rewrite it. Seen live: Reddit sends this event
// only when the author edits (not for approvals, reports or removals), and
// leaves its "previous text" empty, so there is nothing to compare against.
app.post<unknown, TriggerResponse, OnCommentUpdateRequest>(
  '/internal/triggers/comment-update',
  async (req, res) => {
    await check(req.body, true);
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
        deps
      );
    } catch (error) {
      log(`error handling mod action ${action ?? '(unknown)'}: ${String(error)}`);
    }
    res.json({});
  }
);

app.post<unknown, TriggerResponse, OnCommentDeleteRequest>(
  '/internal/triggers/comment-delete',
  async (req, res) => {
    const { commentId, source } = req.body;
    try {
      await processCommentDelete({ commentId: commentId ?? '', source }, deps);
    } catch (error) {
      log(`error handling deletion of comment ${commentId ?? '(unknown)'}: ${String(error)}`);
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

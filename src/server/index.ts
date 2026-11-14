import { context, createServer, getServerPort, reddit, settings } from '@devvit/web/server';
import type {
  OnCommentCreateRequest,
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
  thresholdError,
} from './core.ts';

const log = (message: string): void => console.log(`[crowd-boot] ${message}`);

/** Connects the decision logic in core.ts to the real Reddit API. */
const deps: Deps = {
  log,
  get appUsername() {
    return context.appSlug;
  },
  getConfig: async () => parseConfig(await settings.getAll<Record<string, unknown>>()),
  getKarma: (username) => reddit.getUserKarmaFromCurrentSubreddit(username),
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

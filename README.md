# Crowd Boot

When someone posts or edits a comment, Crowd Boot looks up the karma they have
earned **in your subreddit** (not sitewide) and:

- **reports, filters or removes the comment** (your choice) if their subreddit
  karma is below 0
- **bans them** if their subreddit karma is below -10

## The two checkpoints

| Subreddit karma | What happens |
| --- | --- |
| At or above the comment checkpoint (default 0) | Nothing. The comment stays up. |
| Below the comment checkpoint | The comment is reported, filtered or removed. The user is **not** banned. |
| Below the ban checkpoint (default -10) | The same happens to the comment, and the user is banned. |

New members start at 0 subreddit karma, so they are never affected.

## What happens to the comment

You choose one:

| Choice | The comment | Where moderators find it |
| --- | --- | --- |
| **Report** (default) | Stays up | Mod queue, under Needs Review |
| **Filter** | Hidden | Mod queue, under Removed, marked "Filtered by crowd-boot" |
| **Remove** | Hidden | Mod queue, under Removed |
| **Nothing** | Stays up | Not listed |

Report and Filter leave the decision to a moderator, who approves the comment
or removes it. Both show Crowd Boot's reason.

An edited comment is checked again like a new one, so nobody can get a comment
approved and then rewrite it. An edit never causes a ban; only a new comment
can.

## A last chance before the ban

Between the two checkpoints Crowd Boot deals with a user's comments, but they
can still **post**: it never acts on posts. If the community upvotes those
posts, the user's subreddit karma climbs back over the comment checkpoint and
their comments are left alone again. If it keeps falling below the ban
checkpoint, their next comment gets them banned.

You set how generous this is:

- **Wider gap** between the checkpoints: a longer last chance.
- **Same number** for both: no last chance.
- **"Ban low-karma users" off**: comments are still dealt with, nobody is ever
  banned.
- **"Comments in this subreddit only"**: no last chance, because post karma
  stops counting. Keep the default if you want users to be able to recover.

## About subreddit karma

Karma is an approximate reflection of how your community has voted, so upvotes
and karma don't have a 1:1 relationship. Reddit works it out with its own
formula. Crowd Boot does no maths of its own: it acts on the subreddit karma
Reddit reports for the user at the moment they post or edit a comment.

## Moderators have the final say

- **Unban a user Crowd Boot banned** and it will never ban that user again.
- **Approve a comment Crowd Boot removed** and it will stop acting on that
  user's comments. This applies to the Remove choice. Approving a reported or
  filtered comment is an ordinary review of that one comment.

Crowd Boot records an override as a mod note on the user. Delete that note and
Crowd Boot treats the user like anyone else again.

Crowd Boot keeps no karma or score of its own. It only remembers its own bans
and removals, for 30 days, so it can tell when a moderator reverses one. To
protect someone it banned longer ago than that, add them to your exempt list.

## Who is never touched

- Moderators
- Approved users (while "Never act on approved users" is on)
- Anyone on your exempt list
- AutoModerator and Crowd Boot's own account

If Reddit's karma lookup fails for any reason, Crowd Boot does nothing rather
than guess.

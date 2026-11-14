# Crowd Boot

When someone comments, Crowd Boot looks up the karma they have earned **in your
subreddit** (not sitewide) and:

- **removes the comment** if their subreddit karma is below 0
- **bans them** if their subreddit karma is below -10

## The two checkpoints

| Subreddit karma | What happens |
| --- | --- |
| At or above the removal checkpoint (default 0) | Nothing. The comment stays up. |
| Below the removal checkpoint | The comment is removed. The user is **not** banned. |
| Below the ban checkpoint (default -10) | The comment is removed and the user is banned. |

New members start at 0 subreddit karma, so they are never affected.

## A last chance before the ban

Between the two checkpoints, a user's comments are removed but they can still
**post**. Crowd Boot never removes posts. If the community upvotes those posts,
the user's subreddit karma climbs back over the removal checkpoint and their
comments stay up again. If it keeps falling below the ban checkpoint, their
next comment gets them banned.

You set how generous this is:

- **Wider gap** between the checkpoints: a longer last chance.
- **Same number** for both: no last chance.
- **"Ban low-karma users" off**: comments are removed, nobody is ever banned.
- **"Comments in this subreddit only"**: no last chance, because post karma
  stops counting. Keep the default if you want users to be able to recover.

## About subreddit karma

Karma is an approximate reflection of how your community has voted, so upvotes
and karma don't have a 1:1 relationship. Reddit works it out with its own
formula. Crowd Boot does no maths of its own: it acts on the subreddit karma
Reddit reports for the user at the moment they comment.

## Who is never touched

- Moderators
- Approved users (while "Never act on approved users" is on)
- Anyone on your exempt list
- AutoModerator and Crowd Boot's own account

If Reddit's karma lookup fails for any reason, Crowd Boot does nothing rather
than guess.

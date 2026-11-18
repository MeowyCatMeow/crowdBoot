# Crowd Boot

When someone posts or edits a comment, Crowd Boot looks up the karma they have
earned **in your subreddit** (not sitewide) and acts on it.

| Subreddit karma | What happens |
| --- | --- |
| 0 or above | Nothing |
| Below 0 | The comment is reported, filtered or removed |
| Below -10 | The same, and the user is banned |

You can change both numbers. New members start at 0, so they are never affected.

## What happens to the comment

Pick one option in the app's settings:

| Option | The comment | Where moderators find it |
| --- | --- | --- |
| **Report** (default) | Stays up | Mod queue, under Needs Review |
| **Filter** | Hidden until a moderator approves it | Mod queue, under Removed |
| **Remove** | Hidden | Mod queue, under Removed |
| **Nothing** | Stays up | Not listed |

## A last chance before the ban

Between the two numbers a user is not banned, and Crowd Boot never acts on
posts. If the community upvotes their posts, their karma climbs back and their
comments are left alone again. A wider gap between the numbers gives a longer
last chance; the same number for both gives none.

## Moderators have the final say

- **Unban a user Crowd Boot banned** and it never bans them again.
- **Approve a comment Crowd Boot removed** and it stops acting on that user's
  comments. Approving a reported or filtered comment only approves that one.

Each override is saved as a mod note on the user. Delete the note to undo it.

## Details

- **Karma** is Reddit's own number and only an approximate reflection of votes:
  upvotes and karma don't have a 1:1 relationship. Crowd Boot keeps no score
  of its own.
- **Edits** can get a comment reported, filtered or removed, but never banned.
- **Never touched:** moderators, approved users, anyone on your exempt list,
  and AutoModerator.
- **Memory:** Crowd Boot remembers its own bans and removals for 30 days at
  most. To protect someone it banned longer ago, add them to your exempt list.

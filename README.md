# Birthday bot (free, GitHub Actions)

Posts a birthday announcement to a Slack channel and DMs the person on their
birthday, plus a heads-up DM the day before. Runs on a GitHub Actions cron —
no server, no paid service.

## Setup

1. **Add people** in the `BIRTHDAYS_JSON` repo secret — *not* in a file in
   this repo. It holds the whole JSON array; see
   [birthdays.example.json](birthdays.example.json) for the shape. The list
   is personal data about colleagues, so keeping it out of the repository is
   what allows this repo to be public — which is what makes Actions minutes
   free (see *Why the repo is public* below). `birthdays.json` is
   `.gitignore`d: keep a local copy to paste from, but never commit it.

   **Paste it minified** (one line, no newlines). GitHub masks each line of a
   multi-line secret in build logs, which can scatter `***` through otherwise
   readable output.

   Fields:
   - `name` — for your own reference only.
   - `slackUserId` — from a person's Slack profile → "..." → Copy member ID.
     Can be left `""` if you only have a name and no Slack account for them
     (they just won't receive/trigger any messages).
   - `date` — `MM-DD`. Leave as `""` if someone wants to receive reminders
     about *other* people's birthdays but doesn't want their own birthday
     announced or congratulated.
   - `wantsRemindersOnBday`, `wantsReminders1DayBefore`,
     `wantsRemindersWeekBefore` — booleans, set independently. These control
     whether *this person* gets a DM nudging them to congratulate whoever's
     birthday is coming up (they never get nudged about their own).

   [images.json](images.json) is a pool of image/gif URLs — one is picked at
   random and attached to the channel announcement and the birthday-person's
   own DM (not the reminder DMs sent to everyone else). Add more URLs to the
   array to build up variety.

2. **Repo secrets** (Settings → Secrets and variables → Actions):
   - `BIRTHDAYS_JSON` — the birthday list, as described above.
   - `SLACK_BOT_TOKEN` — already added.
   - `SLACK_CHANNEL_ID` — the announcement channel's ID. Since the bot
     wasn't given `channels:read`, get this manually: open the channel in
     Slack → channel name → "About" → scroll to the bottom, or check the
     URL when viewing the channel in a browser (`.../messages/C0XXXXXXX`).
   - Invite the bot to that channel in Slack: `/invite @YourBotName`.

3. **Test it**: Actions tab → "Birthday bot" → "Run workflow". To test a
   specific person, temporarily give them *tomorrow's* date in the
   `BIRTHDAYS_JSON` secret — each run schedules the next day, so a plain run
   needs no **force**. Tick **force** only to override the double-send
   protection or to send after the delivery time has passed (see *Things
   worth knowing* below).

## Why the repo is public

Actions minutes are metered for private repositories. In November 2026 a set
of `$0` budgets on the account blocked every workflow run — not because
anything had been spent (`$0.00` of `$0.00`), but because a `$0` limit counts
as reached before anything starts. That cost a birthday.

GitHub's docs state that standard runners in public repositories "remain[]
free independently and [do] not reduce the included compute usage", so a
public repo is immune to that whole class of billing failure. The price of
that is that nothing private can live in the repo — hence `BIRTHDAYS_JSON`.

## Schedule

Messages are delivered at exactly 10:00 `Europe/Berlin`, because the
script hands them to Slack's `chat.scheduleMessage` with a computed
(DST-safe) timestamp rather than posting them itself. Slack does the
delivery, so GitHub's timing has no effect on when people see them.

**Each run schedules the *next* day's messages.** GitHub's `schedule`
trigger is best-effort: in practice these runs are routinely 45+ minutes
late and have been seen more than eleven hours late. When runs targeted
the same day's 10:00 they had a ~2 hour margin, and roughly a quarter of
them missed it. Targeting tomorrow gives ~26 hours instead, so a delayed
run is harmless.

Two cron entries (04:17 and 13:17 UTC) provide redundancy in case a run
is dropped altogether. Whichever runs second finds the messages already
scheduled and exits without duplicating them. Both are off the top of
the hour, which is the most contended slot.

If a run somehow executes *after* the delivery time it has already
missed, it skips those messages rather than sending them hours late —
but it exits non-zero and lists them, so the failure is visible instead
of silent. Re-run with **force** to send them anyway.

## Things worth knowing

**Double-send protection.** Before sending, the script asks Slack what's
already scheduled for today's 10:00 slot and exits if it finds anything,
so a manual dispatch on top of the scheduled run won't duplicate
messages. A `concurrency` group additionally prevents two runs
overlapping. If 10:00 has already passed, the script skips rather than
sending late — both guards are bypassed by the **force** input.

**Once scheduled, messages can't be recalled by editing this repo.**
After the 6:00 UTC run hands them to Slack, fixing a typo in
`birthdays.json` will *not* stop the 10:00 delivery — that needs
`chat.deleteScheduledMessage` against the Slack API.

**Partial failures don't stop the run.** A stale or deactivated
`slackUserId` makes that one message fail; every other message is still
attempted, and the job then exits non-zero with a summary so GitHub
emails you about it. Check the run log for `FAILED:` lines.

**Bad dates fail loudly.** `birthdays.json` is validated before anything
is sent — a malformed date like `"08-2"` aborts the run rather than
silently never matching. Feb 29 birthdays fire on Feb 28 in non-leap
years.

**Rate limiting.** Calls are paced (~1.3s apart) and 429s are retried
honoring `Retry-After`. The busiest possible day (a birthday today, one
tomorrow, and one next week, fanning out to ~25 people) is ~75 calls and
under two minutes of runtime. DMs are addressed by passing the `U...`
user id straight to `chat.scheduleMessage`, which resolves it to that
user's IM — so there is no `conversations.open` call per recipient.

**Image URLs are checked on every run**, and a broken one fails the run
even on a day with no birthdays — because that is the cheap moment to
find out. If Slack still rejects an image at send time (it returns
`invalid_blocks` when it cannot fetch the URL), the message is re-sent
as text only rather than being lost.

Note that Wikimedia's `/thumb/` URLs are not reliably valid — the
scaled variant of a file can return HTTP 400 even when the original
returns 200. Prefer the original file URL, and verify any new URL with
the "Test DM (manual only)" workflow: it sends a single DM to one user
id using the first URL in `images.json`, never reads `birthdays.json`,
and is never given `SLACK_CHANNEL_ID`, so it cannot message the team.

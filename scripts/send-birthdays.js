// Birthday bot — runs once daily via GitHub Actions, well before 10:00
// Europe/Berlin. Every message is handed to Slack's chat.scheduleMessage so
// Slack delivers it at exactly 10:00 local time, independent of when the
// Actions runner actually started (schedule triggers are best-effort and
// can lag by minutes).

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const FORCE_SEND = /^(1|true|yes)$/i.test(process.env.FORCE_SEND ?? '');

if (!SLACK_TOKEN) throw new Error('SLACK_BOT_TOKEN is not set');
if (!CHANNEL_ID) throw new Error('SLACK_CHANNEL_ID is not set');

const TIME_ZONE = 'Europe/Berlin';
const TARGET_HOUR = 10;

// chat.scheduleMessage is Tier 3 (~50 requests/minute). Pace every call to
// stay under that; 429s are retried as a backstop. A busy day (a birthday
// today + one tomorrow + one next week, fanning out to ~25 people) is ~75
// calls, which would risk the limit unpaced.
const MIN_CALL_GAP_MS = 1300;
const MAX_RETRIES = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- dates ---

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// Feb 29 birthdays are celebrated on Feb 28 in non-leap years — without this
// they would silently never fire for three years out of four.
function celebratedOn(personDate, year) {
  return personDate === '02-29' && !isLeapYear(year) ? '02-28' : personDate;
}

// Safe against DST only because this job runs at 07:00–08:00 Berlin time:
// adding a flat 24h can shift wall-clock by an hour, which would matter if
// the run were near local midnight. Keep the cron well away from midnight.
function berlinParts(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type).value;
  return { year: Number(get('year')), monthDay: `${get('month')}-${get('day')}` };
}

function berlinOffsetMinutes(date) {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    timeZoneName: 'shortOffset',
  })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName').value; // e.g. "GMT+2"
  const match = name.match(/GMT([+-]\d+)/);
  return match ? parseInt(match[1], 10) * 60 : 0;
}

// Unix timestamp (seconds) for TARGET_HOUR local time on the Berlin calendar
// day `offsetDays` from now.
function targetHourUnix(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const wallClock = Date.UTC(get('year'), get('month') - 1, get('day'), TARGET_HOUR, 0, 0);

  // Two passes: the offset in effect right now may not be the one in effect at
  // the target instant (the clocks change overnight twice a year). The first
  // pass gets close enough to look up the correct offset for the second.
  const firstPass = wallClock - berlinOffsetMinutes(new Date(wallClock)) * 60000;
  return Math.floor((wallClock - berlinOffsetMinutes(new Date(firstPass)) * 60000) / 1000);
}

// ------------------------------------------------------------ validation ---

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const REMINDER_FIELDS = [
  'wantsRemindersOnBday',
  'wantsReminders1DayBefore',
  'wantsRemindersWeekBefore',
];

function dateError(date) {
  if (!/^\d{2}-\d{2}$/.test(date)) return `"${date}" is not in MM-DD format`;
  const [month, day] = date.split('-').map(Number);
  if (month < 1 || month > 12) return `"${date}" has an invalid month`;
  if (day < 1 || day > DAYS_IN_MONTH[month - 1]) return `"${date}" has an invalid day`;
  return null;
}

// A malformed date is the dangerous kind of typo: it simply never matches, so
// the person silently never gets a birthday and nobody notices for a year.
// Those abort the run outright, before anything is sent.
//
// Everything else is returned as a problem rather than thrown: the messages
// should still go out, but the run must end red. This matters more now that
// the list lives in a secret — there is no pull request on a secret, so a
// typo gets no review and the run log is the only place it can surface.
function validate(birthdays) {
  const errors = [];
  const problems = [];
  const seenIds = new Map();

  birthdays.forEach((person, index) => {
    const label = `${person.name || '(unnamed)'} [index ${index}]`;

    if (typeof person.name !== 'string' || !person.name.trim()) {
      errors.push(`${label}: missing "name"`);
    }
    if (typeof person.date !== 'string') {
      errors.push(`${label}: missing "date" (use "" to opt out of announcements)`);
    } else if (person.date !== '') {
      const err = dateError(person.date);
      if (err) errors.push(`${label}: ${err}`);
    }
    if (typeof person.slackUserId !== 'string') {
      errors.push(`${label}: missing "slackUserId" (use "" if unknown)`);
    } else if (person.slackUserId) {
      if (seenIds.has(person.slackUserId)) {
        // Almost always the wrong member ID pasted in: the birthday message
        // then goes to whoever actually owns that id, and the real person
        // gets nothing.
        problems.push(
          `${label} has the same slackUserId as ${seenIds.get(person.slackUserId)} — ` +
            `one of them is wrong, and their messages will go to the other person`
        );
      }
      seenIds.set(person.slackUserId, label);
    }
    for (const field of REMINDER_FIELDS) {
      if (typeof person[field] !== 'boolean') {
        problems.push(`${label}: "${field}" is not set — treated as false`);
      }
    }
  });

  if (errors.length) {
    throw new Error(`BIRTHDAYS_JSON is invalid:\n  - ${errors.join('\n  - ')}`);
  }
  return problems;
}

// ----------------------------------------------------------------- slack ---

let lastCallAt = 0;

async function paceCall() {
  const wait = lastCallAt + MIN_CALL_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

async function slackApi(method, body) {
  for (let attempt = 0; ; attempt++) {
    await paceCall();

    let res;
    try {
      res = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SLACK_TOKEN}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(2 ** attempt * 1000);
      continue;
    }

    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) throw new Error(`Slack API ${method}: rate limited`);
      const retryAfter = Number(res.headers.get('retry-after')) || 1;
      console.warn(`Rate limited on ${method}, waiting ${retryAfter}s...`);
      await sleep((retryAfter + 1) * 1000);
      continue;
    }

    if (res.status >= 500) {
      if (attempt >= MAX_RETRIES) throw new Error(`Slack API ${method}: HTTP ${res.status}`);
      await sleep(2 ** attempt * 1000);
      continue;
    }

    const data = await res.json();
    if (!data.ok) {
      if (data.error === 'ratelimited' && attempt < MAX_RETRIES) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw new Error(`Slack API ${method} failed: ${data.error}`);
    }
    return data;
  }
}

function buildBlocks(text, imageUrl) {
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  if (imageUrl) {
    blocks.push({ type: 'image', image_url: imageUrl, alt_text: 'birthday image' });
  }
  return blocks;
}

let skippedLate = 0;

async function sendAt(channel, text, postAtUnix, imageUrl) {
  const isLate = postAtUnix <= Math.floor(Date.now() / 1000);

  if (isLate && !FORCE_SEND) {
    // Should be unreachable now that the target is tomorrow's 10:00 — it would
    // take a >26h delay to get here. Sending anyway risks duplicating what an
    // earlier run already delivered, so skip, but count it: a silent skip here
    // is how a birthday would go unnoticed, so the run must go red for it.
    skippedLate++;
    console.error(`SKIPPED (target time already passed): ${text}`);
    return;
  }

  const deliver = (blocks) =>
    isLate
      ? slackApi('chat.postMessage', { channel, text, blocks })
      : slackApi('chat.scheduleMessage', { channel, text, blocks, post_at: postAtUnix });

  try {
    await deliver(buildBlocks(text, imageUrl));
  } catch (err) {
    // A decorative image must never cost someone their birthday message. Slack
    // rejects the entire message with invalid_blocks if it cannot fetch the
    // image URL, so retry with the text alone rather than losing the message.
    if (imageUrl && err.message.includes('invalid_blocks')) {
      console.warn(`Slack rejected the image (${imageUrl}) — sending text only.`);
      await deliver(buildBlocks(text, undefined));
      return;
    }
    throw err;
  }
}

// Both chat.scheduleMessage and chat.postMessage accept a "U..." user id as
// `channel` and resolve it to that user's IM themselves — verified against
// this workspace, see scripts/test-dm.js. So no conversations.open call is
// needed, which halves the number of API requests per run.
async function dmAt(userId, text, postAtUnix, imageUrl) {
  if (!userId) {
    console.warn(`Skipping DM — no slackUserId (text: "${text}")`);
    return;
  }
  await sendAt(userId, text, postAtUnix, imageUrl);
}

// Guards against double-sending when one run lands on top of another. Only
// catches messages still pending delivery — once 10:00 has passed they are
// gone from this list, which is why a late run refuses to send instead.
//
// The oldest/latest parameters are deliberately not used: Slack rejects a
// `latest` in the past with invalid_ts_latest, which broke every run that
// executed after 10:00 Berlin. The window is applied client-side instead —
// the list only ever holds a single day's messages.
async function countAlreadyScheduled(postAtUnix) {
  const { scheduled_messages: messages = [] } = await slackApi(
    'chat.scheduledMessages.list',
    { limit: 200 }
  );
  return messages.filter((m) => Math.abs(m.post_at - postAtUnix) <= 60).length;
}

// ------------------------------------------------------------------ main ---

function randomImage(images) {
  return images.length ? images[Math.floor(Math.random() * images.length)] : undefined;
}

// Image URLs are only exercised on an actual birthday, so a URL that rots (or
// was wrong from the start) stays invisible until the worst possible moment.
// Check them on every run instead — most days there is no birthday, and that
// is exactly when it is cheap to find out.
async function checkImageUrls(images) {
  const broken = [];
  for (const url of images) {
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      if (!res.ok) broken.push(`image URL unreachable: ${url} -> HTTP ${res.status}`);
    } catch (err) {
      broken.push(`image URL unreachable: ${url} -> ${err.message}`);
    }
  }
  return broken;
}

// The birthday list is personal data about colleagues, so it lives in the
// BIRTHDAYS_JSON repo secret rather than in the repository — that is what lets
// this repo be public, which in turn makes Actions minutes free and immune to
// billing/budget blocks. See birthdays.example.json for the shape.
function loadBirthdays() {
  const raw = process.env.BIRTHDAYS_JSON;
  if (!raw || !raw.trim()) {
    throw new Error(
      'BIRTHDAYS_JSON is not set. Add the birthday list as a repo secret ' +
        '(Settings -> Secrets and variables -> Actions). See birthdays.example.json.'
    );
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    return parsed;
  } catch (err) {
    // Deliberately does not echo the value — it would land in the build log.
    throw new Error(`BIRTHDAYS_JSON is not valid JSON: ${err.message}`);
  }
}

async function main() {
  const fs = await import('node:fs/promises');
  const birthdays = loadBirthdays();
  const images = JSON.parse(await fs.readFile(new URL('../images.json', import.meta.url)));

  const dataProblems = validate(birthdays);
  const brokenImages = await checkImageUrls(images);
  for (const problem of [...dataProblems, ...brokenImages]) {
    console.error(`WARNING: ${problem}`);
  }

  // Everything is scheduled for TOMORROW's 10:00, not today's. GitHub's
  // scheduled runs are routinely tens of minutes late and have been observed
  // more than eleven hours late, which repeatedly pushed execution past 10:00
  // Berlin. Targeting tomorrow gives a ~26 hour cushion instead of ~2, so a
  // delayed run is harmless. The date windows shift forward by a day to match:
  // the person whose birthday is tomorrow gets the announcement, and so on.
  const postAtUnix = targetHourUnix(1);
  const onTheDay = berlinParts(1);
  const dayBefore = berlinParts(2);
  const weekBefore = berlinParts(8);

  // This is a guard, not the job. If it breaks, missing everyone's birthday is
  // a far worse outcome than a possible duplicate, so log loudly and carry on
  // rather than aborting — but still fail the run at the end so it gets fixed.
  let guardError = null;
  try {
    const pending = await countAlreadyScheduled(postAtUnix);
    if (pending > 0 && !FORCE_SEND) {
      console.log(
        `${pending} message(s) are already scheduled for the ${TARGET_HOUR}:00 delivery slot — ` +
          `this run would duplicate them. Exiting. (Set FORCE_SEND=true to override.)`
      );
      return;
    }
  } catch (err) {
    guardError = `duplicate-send check failed: ${err.message}`;
    console.error(
      `WARNING: ${guardError}\n` +
        `Continuing without duplicate protection. Messages below were still sent — ` +
        `do NOT re-run this job today, or people will get them twice.`
    );
  }

  // One bad user ID must not stop the run: with staff turnover, a deactivated
  // account throwing user_not_found would otherwise silently deprive everyone
  // further down the list. Collect failures and report them at the end.
  const failures = [];
  const attempt = async (label, fn) => {
    try {
      await fn();
      console.log(`OK: ${label}`);
    } catch (err) {
      console.error(`FAILED: ${label} — ${err.message}`);
      failures.push(`${label} — ${err.message}`);
    }
  };

  for (const person of birthdays) {
    // No date set — this person opted out of having their own birthday
    // announced/congratulated, but can still receive reminders about others.
    if (!person.date) continue;

    const subscribers = (field) =>
      birthdays.filter((p) => p !== person && p[field] === true);

    if (celebratedOn(person.date, onTheDay.year) === onTheDay.monthDay) {
      const image = randomImage(images);
      if (person.slackUserId) {
        await attempt(`channel announcement for ${person.name}`, () =>
          sendAt(CHANNEL_ID, `🎉 Happy birthday, <@${person.slackUserId}>! 🎂`, postAtUnix, image)
        );
        await attempt(`birthday DM to ${person.name}`, () =>
          dmAt(person.slackUserId, `Happy birthday! 🎉🎂`, postAtUnix, image)
        );
      }
      for (const subscriber of subscribers('wantsRemindersOnBday')) {
        await attempt(`on-day reminder to ${subscriber.name} re ${person.name}`, () =>
          dmAt(
            subscriber.slackUserId,
            `🎂 It's ${person.name}'s birthday today — go say happy birthday!`,
            postAtUnix
          )
        );
      }
    } else if (celebratedOn(person.date, dayBefore.year) === dayBefore.monthDay) {
      for (const subscriber of subscribers('wantsReminders1DayBefore')) {
        await attempt(`day-before reminder to ${subscriber.name} re ${person.name}`, () =>
          dmAt(
            subscriber.slackUserId,
            `🎈 Reminder: it's ${person.name}'s birthday tomorrow.`,
            postAtUnix
          )
        );
      }
    } else if (celebratedOn(person.date, weekBefore.year) === weekBefore.monthDay) {
      for (const subscriber of subscribers('wantsRemindersWeekBefore')) {
        await attempt(`week-before reminder to ${subscriber.name} re ${person.name}`, () =>
          dmAt(
            subscriber.slackUserId,
            `📅 Heads up: ${person.name}'s birthday is in a week.`,
            postAtUnix
          )
        );
      }
    }
  }

  if (skippedLate > 0) {
    failures.unshift(
      `${skippedLate} message(s) skipped because the run executed after ${TARGET_HOUR}:00 ` +
        `Berlin on the delivery day. Re-run with force=true to send them late.`
    );
  }
  if (guardError) failures.unshift(guardError);
  failures.unshift(...dataProblems, ...brokenImages);

  if (failures.length) {
    throw new Error(`${failures.length} problem(s):\n  - ${failures.join('\n  - ')}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

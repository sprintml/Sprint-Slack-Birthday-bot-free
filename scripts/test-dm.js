// One-off diagnostic. Sends exactly ONE DM, to exactly ONE user id, and
// nothing else — it deliberately does not read birthdays.json and does not
// know SLACK_CHANNEL_ID, so it cannot message the team or the channel.
//
// It answers two open questions at once:
//   1. Does chat.scheduleMessage accept a "U..." user id as `channel` and
//      auto-resolve it to the IM? (Documented for chat.postMessage; unclear
//      for chat.scheduleMessage.) If yes, the main script can drop its
//      conversations.open call and halve its API calls.
//   2. Does the image URL in images.json actually render in Slack? Wikimedia
//      URLs carry query params and are served through Slack's image proxy,
//      so this is worth confirming before a real birthday depends on it.

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const TARGET_USER_ID = process.env.TEST_USER_ID;

if (!SLACK_TOKEN) throw new Error('SLACK_BOT_TOKEN is not set');
if (!/^U[A-Z0-9]+$/.test(TARGET_USER_ID ?? '')) {
  throw new Error(`TEST_USER_ID must be a Slack user id like U0123ABCD (got: ${TARGET_USER_ID})`);
}

async function slackApi(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log(`${method} -> ${JSON.stringify(data, null, 2)}`);
  return data;
}

async function main() {
  const fs = await import('node:fs/promises');
  const images = JSON.parse(await fs.readFile(new URL('../images.json', import.meta.url)));
  const imageUrl = images[0];

  const postAt = Math.floor(Date.now() / 1000) + 90;

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '🧪 Birthday bot test — if you can see the image below, `images.json` renders correctly.',
      },
    },
  ];
  if (imageUrl) {
    blocks.push({ type: 'image', image_url: imageUrl, alt_text: 'birthday image' });
  }

  console.log(`Scheduling a single DM to ${TARGET_USER_ID} for ${new Date(postAt * 1000)}...`);

  // The actual experiment: pass the user id straight in as `channel`.
  const result = await slackApi('chat.scheduleMessage', {
    channel: TARGET_USER_ID,
    text: 'Birthday bot test message',
    blocks,
    post_at: postAt,
  });

  console.log('\n=================== RESULT ===================');
  if (result.ok) {
    console.log(`PASS: chat.scheduleMessage accepted a user id directly.`);
    console.log(`Resolved channel: ${result.channel} (a "D..." id means it opened the IM)`);
    console.log(`The main script can drop conversations.open and halve its API calls.`);
    console.log(`\nWatch your DMs in ~90s and confirm the image renders.`);
  } else {
    console.log(`FAIL: chat.scheduleMessage rejected a bare user id (${result.error}).`);
    console.log(`Keep conversations.open in the main script.`);
    if (result.error === 'channel_not_found') {
      console.log(`("channel_not_found" here specifically means no U->IM auto-resolution.)`);
    }
  }
  console.log('==============================================');

  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReplyAddresses } from '../lib/smtp.js';
import { assertReplyStaysWithAccount, assertSelfOnlyRecipients } from './send-guard.js';

const ACCOUNT = 'you@icloud.com';

test('guard blocks a foreign recipient', () => {
  assert.throws(
    () => assertSelfOnlyRecipients({ to: ACCOUNT, cc: 'other@example.com' }, ACCOUNT),
    /Refusing to email anyone but the tested account/
  );
  assert.throws(
    () => assertSelfOnlyRecipients({ to: '  You@iCloud.com ', bcc: 'Person <other@example.com>' }, ACCOUNT),
    /Refusing to email anyone but the tested account/
  );
});

test('guard allows only the tested account after case and whitespace normalization', () => {
  const allowed = assertSelfOnlyRecipients({
    to: '  You@iCloud.com ',
    cc: 'Person <you@icloud.com>',
  }, ACCOUNT);
  assert.deepEqual(allowed, [ACCOUNT, ACCOUNT]);
});

test('guard blocks reply-all to a message with other recipients', () => {
  const email = {
    from: ACCOUNT,
    headers: {
      replyTo: null,
      to: [ACCOUNT, 'other@example.com'],
      cc: ['third@example.com'],
    },
  };
  // The server would mail the other parties. The guard must stop that first.
  const planned = planReplyAddresses(email, ACCOUNT, true);
  assert.ok(planned.map((addr) => addr.toLowerCase()).includes('other@example.com'));
  assert.throws(
    () => assertReplyStaysWithAccount(email, ACCOUNT, { replyAll: true }),
    /Refusing reply-all/
  );
});

test('guard allows reply and reply-all only for a self-seed', () => {
  const email = {
    from: '  You@iCloud.com ',
    headers: { replyTo: null, to: ['you@icloud.com'], cc: [] },
  };
  assert.deepEqual(
    assertReplyStaysWithAccount(email, ACCOUNT, { replyAll: false }).map((addr) => addr.trim().toLowerCase()),
    [ACCOUNT]
  );
  assert.deepEqual(
    assertReplyStaysWithAccount(email, ACCOUNT, { replyAll: true }),
    [ACCOUNT]
  );
  assert.throws(
    () => assertReplyStaysWithAccount({ from: 'other@example.com', headers: { to: [ACCOUNT], cc: [] } }, ACCOUNT, { replyAll: false }),
    /Refusing to email anyone but the tested account/
  );
});

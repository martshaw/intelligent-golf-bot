/* Offline checks of Telegram HTML helpers. */
import assert from 'assert';
import { escapeHtml, htmlToPlain } from '../src/shared/html';

assert.strictEqual(escapeHtml('A & B <x>'), 'A &amp; B &lt;x&gt;');
assert.strictEqual(escapeHtml('✅ Brian Mckinlay'), '✅ Brian Mckinlay');
const msg = `<b>✅ Auto Booked!</b>\n<b>Participants:</b> ${escapeHtml('Tom & Jerry <guest>')}\n`;
assert.strictEqual(htmlToPlain(msg), '✅ Auto Booked!\nParticipants: Tom & Jerry <guest>\n');
console.log('html.check: all assertions passed');

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { increment } from './counter.mjs';

test('increment adds one', () => {
  assert.equal(increment(1), 2);
});

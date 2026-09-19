import { expect, test } from 'vitest';
import { add } from '../src/math.js';

test('math works', () => {
  expect(add(1, 2)).toBe(3);
});

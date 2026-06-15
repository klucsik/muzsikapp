import { describe, it, expect } from 'vitest';
import { add } from '../src/math.js';

describe('Frontend Smoke Test', () => {
  it('should work', () => {
    expect(add(1, 2)).toBe(3);
  });
});

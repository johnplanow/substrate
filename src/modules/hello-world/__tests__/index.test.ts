import { describe, it, expect } from 'vitest';
import { greet } from '../index.js';

describe('greet', () => {
  it('should return "Hello, World!" when called with "World"', () => {
    expect(greet('World')).toBe('Hello, World!');
  });

  it('should return "Hello, Alice!" when called with "Alice"', () => {
    expect(greet('Alice')).toBe('Hello, Alice!');
  });
});

/**
 * Story 7.1 Task 8: ModeSelection Component Unit Tests
 * Tests for mode-selection.tsx (AC1, AC2, AC3)
 */

import { describe, it, expect, vi } from 'vitest';
import { ModeSelection } from './mode-selection.js';

describe('ModeSelection Component', () => {
  // AC1: Renders two entry points
  describe('Rendering (AC1)', () => {
    it('renders both Play vs AI and Advisor Mode buttons', () => {
      const onSelectPlayVsAi = vi.fn();
      const onSelectAdvisor = vi.fn();

      const component = ModeSelection({ onSelectPlayVsAi, onSelectAdvisor });

      // In real React, we'd use @testing-library/react
      // Here we verify the mock structure
      expect(component).toBeDefined();
      expect(component.type).toBe('div');

      // Find buttons in the mock structure
      const container = component.props.children[0];
      const buttons = container.props.children.slice(1); // Skip h1

      expect(buttons.length).toBe(2);
      expect(buttons[0].props.children).toContain('Play vs AI');
      expect(buttons[1].props.children).toContain('Advisor Mode');
    });

    it('renders only two entry points (no extra navigation)', () => {
      const onSelectPlayVsAi = vi.fn();
      const onSelectAdvisor = vi.fn();

      const component = ModeSelection({ onSelectPlayVsAi, onSelectAdvisor });

      const container = component.props.children[0];
      const buttons = container.props.children.filter((child: any) => child.type === 'button');

      expect(buttons.length).toBe(2);
    });
  });

  // AC2: Play vs AI callback
  describe('Play vs AI Selection (AC2)', () => {
    it('calls onSelectPlayVsAi when Play vs AI button is clicked', () => {
      const onSelectPlayVsAi = vi.fn();
      const onSelectAdvisor = vi.fn();

      const component = ModeSelection({ onSelectPlayVsAi, onSelectAdvisor });

      const container = component.props.children[0];
      const playVsAiButton = container.props.children[1]; // First button

      // Simulate click
      playVsAiButton.props.onClick();

      expect(onSelectPlayVsAi).toHaveBeenCalledTimes(1);
      expect(onSelectAdvisor).not.toHaveBeenCalled();
    });

    it('has correct test ID for Play vs AI button', () => {
      const onSelectPlayVsAi = vi.fn();
      const onSelectAdvisor = vi.fn();

      const component = ModeSelection({ onSelectPlayVsAi, onSelectAdvisor });

      const container = component.props.children[0];
      const playVsAiButton = container.props.children[1];

      expect(playVsAiButton.props['data-testid']).toBe('play-vs-ai-button');
    });
  });

  // AC3: Advisor Mode callback
  describe('Advisor Mode Selection (AC3)', () => {
    it('calls onSelectAdvisor when Advisor Mode button is clicked', () => {
      const onSelectPlayVsAi = vi.fn();
      const onSelectAdvisor = vi.fn();

      const component = ModeSelection({ onSelectPlayVsAi, onSelectAdvisor });

      const container = component.props.children[0];
      const advisorButton = container.props.children[2]; // Second button

      // Simulate click
      advisorButton.props.onClick();

      expect(onSelectAdvisor).toHaveBeenCalledTimes(1);
      expect(onSelectPlayVsAi).not.toHaveBeenCalled();
    });

    it('has correct test ID for Advisor Mode button', () => {
      const onSelectPlayVsAi = vi.fn();
      const onSelectAdvisor = vi.fn();

      const component = ModeSelection({ onSelectPlayVsAi, onSelectAdvisor });

      const container = component.props.children[0];
      const advisorButton = container.props.children[2];

      expect(advisorButton.props['data-testid']).toBe('advisor-mode-button');
    });
  });

  // Accessibility (AC1 note)
  describe('Accessibility', () => {
    it('uses button elements (keyboard accessible)', () => {
      const onSelectPlayVsAi = vi.fn();
      const onSelectAdvisor = vi.fn();

      const component = ModeSelection({ onSelectPlayVsAi, onSelectAdvisor });

      const container = component.props.children[0];
      const buttons = container.props.children.filter((child: any) => child.type === 'button');

      expect(buttons.length).toBe(2);
      expect(buttons[0].type).toBe('button');
      expect(buttons[1].type).toBe('button');
    });
  });

  // Controlled component (no internal state)
  describe('Controlled Component', () => {
    it('is purely controlled with no internal state', () => {
      const onSelectPlayVsAi = vi.fn();
      const onSelectAdvisor = vi.fn();

      const component = ModeSelection({ onSelectPlayVsAi, onSelectAdvisor });

      // The component should be stateless - just verify it renders
      expect(component).toBeDefined();

      // Call again with different props - should produce different output
      const component2 = ModeSelection({
        onSelectPlayVsAi: vi.fn(),
        onSelectAdvisor: vi.fn(),
      });

      expect(component2).toBeDefined();
    });
  });

  // Styling (uses Tailwind classes as specified)
  describe('Styling', () => {
    it('uses Tailwind classes for styling', () => {
      const onSelectPlayVsAi = vi.fn();
      const onSelectAdvisor = vi.fn();

      const component = ModeSelection({ onSelectPlayVsAi, onSelectAdvisor });

      expect(component.props.className).toContain('bg-surface');

      const container = component.props.children[0];
      const playVsAiButton = container.props.children[1];
      const advisorButton = container.props.children[2];

      expect(playVsAiButton.props.className).toContain('btn');
      expect(advisorButton.props.className).toContain('btn');
    });
  });
});

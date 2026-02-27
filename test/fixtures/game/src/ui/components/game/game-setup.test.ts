/**
 * Story 7.1 Task 9: GameSetup Component Unit Tests
 * Tests for game-setup.tsx (AC4, AC5, AC6, AC13)
 */

import { describe, it, expect, vi } from 'vitest';
import { GameSetup, type Variant, type OpponentCount } from './game-setup.js';

describe('GameSetup Component', () => {
  const defaultProps = {
    variant: 'easy' as Variant,
    opponentCount: 1 as OpponentCount,
    onVariantChange: vi.fn(),
    onOpponentCountChange: vi.fn(),
    onStartGame: vi.fn(),
    onBack: vi.fn(),
  };

  // AC4: Variant selection
  describe('Variant Selection (AC4)', () => {
    it('renders variant dropdown with all three options', () => {
      const component = GameSetup(defaultProps);

      // Find the select element
      const form = component.props.children[0];
      const variantSection = form.props.children[1]; // Skip h1
      const select = variantSection.props.children[1];

      expect(select.type).toBe('select');
      expect(select.props.children.length).toBe(3);

      const options = select.props.children;
      expect(options[0].props.value).toBe('easy');
      expect(options[0].props.children).toBe('Easy');
      expect(options[1].props.value).toBe('michaels');
      expect(options[1].props.children).toBe("Michael's Setup");
      expect(options[2].props.value).toBe('brunos');
      expect(options[2].props.children).toBe("Bruno's Variant");
    });

    it('calls onVariantChange when variant is selected', () => {
      const onVariantChange = vi.fn();
      const props = { ...defaultProps, onVariantChange };
      const component = GameSetup(props);

      const form = component.props.children[0];
      const variantSection = form.props.children[1];
      const select = variantSection.props.children[1];

      // Simulate change event
      select.props.onChange({ target: { value: 'michaels' } });

      expect(onVariantChange).toHaveBeenCalledWith('michaels');
    });

    it('displays currently selected variant', () => {
      const props = { ...defaultProps, variant: 'brunos' as Variant };
      const component = GameSetup(props);

      const form = component.props.children[0];
      const variantSection = form.props.children[1];
      const select = variantSection.props.children[1];

      expect(select.props.value).toBe('brunos');
    });

    it('has correct test ID for variant select', () => {
      const component = GameSetup(defaultProps);

      const form = component.props.children[0];
      const variantSection = form.props.children[1];
      const select = variantSection.props.children[1];

      expect(select.props['data-testid']).toBe('variant-select');
    });
  });

  // AC5: Opponent count selection
  describe('Opponent Count Selection (AC5, AC13)', () => {
    it('renders opponent count options 1, 2, 3 only', () => {
      const component = GameSetup(defaultProps);

      const form = component.props.children[0];
      const opponentSection = form.props.children[2];
      const radioGroup = opponentSection.props.children[1];
      const labels = radioGroup.props.children;

      expect(labels.length).toBe(3);

      const radio1 = labels[0].props.children[0];
      const radio2 = labels[1].props.children[0];
      const radio3 = labels[2].props.children[0];

      expect(radio1.props.value).toBe('1');
      expect(radio2.props.value).toBe('2');
      expect(radio3.props.value).toBe('3');
    });

    it('displays descriptive labels for each opponent count', () => {
      const component = GameSetup(defaultProps);

      const form = component.props.children[0];
      const opponentSection = form.props.children[2];
      const radioGroup = opponentSection.props.children[1];
      const labels = radioGroup.props.children;

      const label1 = labels[0].props.children[1].props.children;
      const label2 = labels[1].props.children[1].props.children;
      const label3 = labels[2].props.children[1].props.children;

      expect(label1).toContain('1 AI opponent');
      expect(label1).toContain('2-player');
      expect(label2).toContain('2 AI opponents');
      expect(label2).toContain('3-player');
      expect(label3).toContain('3 AI opponents');
      expect(label3).toContain('4-player');
    });

    it('calls onOpponentCountChange when option is selected', () => {
      const onOpponentCountChange = vi.fn();
      const props = { ...defaultProps, onOpponentCountChange };
      const component = GameSetup(props);

      const form = component.props.children[0];
      const opponentSection = form.props.children[2];
      const radioGroup = opponentSection.props.children[1];
      const labels = radioGroup.props.children;

      const radio2 = labels[1].props.children[0];

      // Simulate change
      radio2.props.onChange();

      expect(onOpponentCountChange).toHaveBeenCalledWith(2);
    });

    it('marks the selected opponent count as checked', () => {
      const props = { ...defaultProps, opponentCount: 2 as OpponentCount };
      const component = GameSetup(props);

      const form = component.props.children[0];
      const opponentSection = form.props.children[2];
      const radioGroup = opponentSection.props.children[1];
      const labels = radioGroup.props.children;

      const radio1 = labels[0].props.children[0];
      const radio2 = labels[1].props.children[0];
      const radio3 = labels[2].props.children[0];

      expect(radio1.props.checked).toBe(false);
      expect(radio2.props.checked).toBe(true);
      expect(radio3.props.checked).toBe(false);
    });

    it('supports all valid player counts 2-4 (NFR-022)', () => {
      // playerCount 2 (1 opponent)
      const component2 = GameSetup({ ...defaultProps, opponentCount: 1 });
      expect(component2).toBeDefined();

      // playerCount 3 (2 opponents)
      const component3 = GameSetup({ ...defaultProps, opponentCount: 2 });
      expect(component3).toBeDefined();

      // playerCount 4 (3 opponents)
      const component4 = GameSetup({ ...defaultProps, opponentCount: 3 });
      expect(component4).toBeDefined();
    });
  });

  // AC6: Start Game button
  describe('Start Game Button (AC6)', () => {
    it('renders Start Game button', () => {
      const component = GameSetup(defaultProps);

      const form = component.props.children[0];
      const buttonSection = form.props.children[3];
      const buttons = buttonSection.props.children;

      const startButton = buttons[1]; // Second button (after Back)
      expect(startButton.props.children).toBe('Start Game');
    });

    it('calls onStartGame when Start Game is clicked', () => {
      const onStartGame = vi.fn();
      const props = { ...defaultProps, onStartGame };
      const component = GameSetup(props);

      const form = component.props.children[0];
      const buttonSection = form.props.children[3];
      const startButton = buttonSection.props.children[1];

      startButton.props.onClick();

      expect(onStartGame).toHaveBeenCalledTimes(1);
    });

    it('is always enabled (defaults satisfy validity)', () => {
      const component = GameSetup(defaultProps);

      const form = component.props.children[0];
      const buttonSection = form.props.children[3];
      const startButton = buttonSection.props.children[1];

      // No disabled prop means enabled
      expect(startButton.props.disabled).toBeUndefined();
    });

    it('has correct test ID', () => {
      const component = GameSetup(defaultProps);

      const form = component.props.children[0];
      const buttonSection = form.props.children[3];
      const startButton = buttonSection.props.children[1];

      expect(startButton.props['data-testid']).toBe('start-game-button');
    });
  });

  // Back button
  describe('Back Button', () => {
    it('renders Back button', () => {
      const component = GameSetup(defaultProps);

      const form = component.props.children[0];
      const buttonSection = form.props.children[3];
      const backButton = buttonSection.props.children[0];

      expect(backButton.props.children).toBe('Back');
    });

    it('calls onBack when Back is clicked', () => {
      const onBack = vi.fn();
      const props = { ...defaultProps, onBack };
      const component = GameSetup(props);

      const form = component.props.children[0];
      const buttonSection = form.props.children[3];
      const backButton = buttonSection.props.children[0];

      backButton.props.onClick();

      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('has correct test ID', () => {
      const component = GameSetup(defaultProps);

      const form = component.props.children[0];
      const buttonSection = form.props.children[3];
      const backButton = buttonSection.props.children[0];

      expect(backButton.props['data-testid']).toBe('back-button');
    });
  });

  // Default values
  describe('Default Values', () => {
    it('displays easy variant as default', () => {
      const component = GameSetup(defaultProps);

      const form = component.props.children[0];
      const variantSection = form.props.children[1];
      const select = variantSection.props.children[1];

      expect(select.props.value).toBe('easy');
    });

    it('displays 1 opponent as default', () => {
      const component = GameSetup(defaultProps);

      const form = component.props.children[0];
      const opponentSection = form.props.children[2];
      const radioGroup = opponentSection.props.children[1];
      const labels = radioGroup.props.children;
      const radio1 = labels[0].props.children[0];

      expect(radio1.props.checked).toBe(true);
    });
  });

  // Controlled component
  describe('Controlled Component', () => {
    it('is fully controlled with no internal state', () => {
      const component1 = GameSetup(defaultProps);
      expect(component1).toBeDefined();

      const props2 = {
        ...defaultProps,
        variant: 'michaels' as Variant,
        opponentCount: 3 as OpponentCount,
      };
      const component2 = GameSetup(props2);
      expect(component2).toBeDefined();

      // Components should reflect their props
      const form1 = component1.props.children[0];
      const form2 = component2.props.children[0];

      const select1 = form1.props.children[1].props.children[1];
      const select2 = form2.props.children[1].props.children[1];

      expect(select1.props.value).toBe('easy');
      expect(select2.props.value).toBe('michaels');
    });
  });

  // Styling
  describe('Styling', () => {
    it('uses Tailwind classes for styling', () => {
      const component = GameSetup(defaultProps);

      expect(component.props.className).toContain('bg-surface');

      const form = component.props.children[0];
      expect(form.props.className).toContain('bg-elevated');
    });
  });
});

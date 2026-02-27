/**
 * Story 7.1: Game Setup Component
 *
 * Allows user to configure variant and opponent count before starting game
 * AC4, AC5, AC6, AC13
 *
 * This is a fixture implementation for BMAD workflow testing.
 * In a real implementation, this would import from 'react'.
 */

export type Variant = 'easy' | 'michaels' | 'brunos';
export type OpponentCount = 1 | 2 | 3;

export interface GameSetupProps {
  variant: Variant;
  opponentCount: OpponentCount;
  onVariantChange: (variant: Variant) => void;
  onOpponentCountChange: (count: OpponentCount) => void;
  onStartGame: () => void;
  onBack: () => void;
}

/**
 * Game Setup component - configure game parameters
 * Fully controlled component with no internal state
 *
 * @param props - Component props
 * @returns Mock JSX element (would be real React.Element in production)
 */
export function GameSetup(props: GameSetupProps): any {
  const { variant, opponentCount, onVariantChange, onOpponentCountChange, onStartGame, onBack } = props;

  return {
    type: 'div',
    props: {
      className: 'game-setup bg-surface min-h-screen flex items-center justify-center',
      children: [
        {
          type: 'div',
          props: {
            className: 'bg-elevated p-8 rounded-lg max-w-lg w-full',
            children: [
              {
                type: 'h1',
                props: {
                  className: 'type-h1 mb-6',
                  children: 'Game Setup',
                },
              },
              // Variant selection
              {
                type: 'div',
                props: {
                  className: 'mb-6',
                  children: [
                    {
                      type: 'label',
                      props: {
                        className: 'type-h2 block mb-2',
                        htmlFor: 'variant-select',
                        children: 'Variant',
                      },
                    },
                    {
                      type: 'select',
                      props: {
                        id: 'variant-select',
                        className: 'w-full p-2 rounded bg-surface',
                        value: variant,
                        onChange: (e: any) => onVariantChange(e.target.value as Variant),
                        'data-testid': 'variant-select',
                        children: [
                          {
                            type: 'option',
                            props: {
                              value: 'easy',
                              children: 'Easy',
                            },
                          },
                          {
                            type: 'option',
                            props: {
                              value: 'michaels',
                              children: "Michael's Setup",
                            },
                          },
                          {
                            type: 'option',
                            props: {
                              value: 'brunos',
                              children: "Bruno's Variant",
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
              // Opponent count selection
              {
                type: 'div',
                props: {
                  className: 'mb-8',
                  children: [
                    {
                      type: 'label',
                      props: {
                        className: 'type-h2 block mb-2',
                        children: 'Number of AI Opponents',
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        className: 'flex flex-col gap-2',
                        children: [
                          {
                            type: 'label',
                            props: {
                              className: 'flex items-center gap-2',
                              children: [
                                {
                                  type: 'input',
                                  props: {
                                    type: 'radio',
                                    name: 'opponent-count',
                                    value: '1',
                                    checked: opponentCount === 1,
                                    onChange: () => onOpponentCountChange(1),
                                    'data-testid': 'opponent-count-1',
                                  },
                                },
                                {
                                  type: 'span',
                                  props: {
                                    children: '1 AI opponent (2-player)',
                                  },
                                },
                              ],
                            },
                          },
                          {
                            type: 'label',
                            props: {
                              className: 'flex items-center gap-2',
                              children: [
                                {
                                  type: 'input',
                                  props: {
                                    type: 'radio',
                                    name: 'opponent-count',
                                    value: '2',
                                    checked: opponentCount === 2,
                                    onChange: () => onOpponentCountChange(2),
                                    'data-testid': 'opponent-count-2',
                                  },
                                },
                                {
                                  type: 'span',
                                  props: {
                                    children: '2 AI opponents (3-player)',
                                  },
                                },
                              ],
                            },
                          },
                          {
                            type: 'label',
                            props: {
                              className: 'flex items-center gap-2',
                              children: [
                                {
                                  type: 'input',
                                  props: {
                                    type: 'radio',
                                    name: 'opponent-count',
                                    value: '3',
                                    checked: opponentCount === 3,
                                    onChange: () => onOpponentCountChange(3),
                                    'data-testid': 'opponent-count-3',
                                  },
                                },
                                {
                                  type: 'span',
                                  props: {
                                    children: '3 AI opponents (4-player)',
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
              // Action buttons
              {
                type: 'div',
                props: {
                  className: 'flex gap-4',
                  children: [
                    {
                      type: 'button',
                      props: {
                        className: 'btn btn-secondary flex-1 py-2 px-4 rounded',
                        onClick: onBack,
                        'data-testid': 'back-button',
                        children: 'Back',
                      },
                    },
                    {
                      type: 'button',
                      props: {
                        className: 'btn btn-primary flex-1 py-2 px-4 rounded',
                        onClick: onStartGame,
                        'data-testid': 'start-game-button',
                        children: 'Start Game',
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };
}

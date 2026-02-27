/**
 * Story 7.1: Mode Selection Component
 *
 * Displays two entry points: "Play vs AI" and "Advisor Mode"
 * AC1, AC2, AC3
 *
 * This is a fixture implementation for BMAD workflow testing.
 * In a real implementation, this would import from 'react'.
 */

export interface ModeSelectionProps {
  onSelectPlayVsAi: () => void;
  onSelectAdvisor: () => void;
}

/**
 * Mode Selection component - default landing state
 * Renders two clearly labeled entry points
 *
 * @param props - Component props
 * @returns Mock JSX element (would be real React.Element in production)
 */
export function ModeSelection(props: ModeSelectionProps): any {
  const { onSelectPlayVsAi, onSelectAdvisor } = props;

  // Mock React component structure
  return {
    type: 'div',
    props: {
      className: 'mode-selection bg-surface flex items-center justify-center min-h-screen',
      children: [
        {
          type: 'div',
          props: {
            className: 'flex flex-col gap-6 max-w-2xl',
            children: [
              {
                type: 'h1',
                props: {
                  className: 'type-h1 text-center mb-8',
                  children: 'Welcome to the Game',
                },
              },
              {
                type: 'button',
                props: {
                  className: 'btn btn-primary bg-elevated hover:bg-surface text-lg py-4 px-8 rounded-lg',
                  onClick: onSelectPlayVsAi,
                  'data-testid': 'play-vs-ai-button',
                  children: 'Play vs AI',
                },
              },
              {
                type: 'button',
                props: {
                  className: 'btn btn-secondary bg-elevated hover:bg-surface text-lg py-4 px-8 rounded-lg',
                  onClick: onSelectAdvisor,
                  'data-testid': 'advisor-mode-button',
                  children: 'Advisor Mode',
                },
              },
            ],
          },
        },
      ],
    },
  };
}

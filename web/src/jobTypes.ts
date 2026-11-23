import iconMove from 'bootstrap-icons/icons/crosshair.svg?raw';
import iconPosition from 'bootstrap-icons/icons/search.svg?raw';
import iconAnalyzeMove from 'bootstrap-icons/icons/activity.svg?raw';
import iconIntuition from 'bootstrap-icons/icons/lightning-charge.svg?raw';
import type { AiJobType } from '../../src/shared/protocol';

/**
 * In priority order: tree search first, intuition jobs are fast and docker workers already process them.
 */
export const JOB_TYPES: AiJobType[] = [
    'katahex-mcts-move',
    'katahex-mcts-analyze-position',
    'katahex-mcts-analyze-move',
    'katahex-intuition-move',
    'katahex-intuition-analyze-position',
    'katahex-intuition-analyze-game',
];

export const DEFAULT_JOB_TYPES: AiJobType[] = ['katahex-mcts-move', 'katahex-mcts-analyze-position', 'katahex-mcts-analyze-move'];

export const JOB_TITLES: Partial<Record<AiJobType, string>> = {
    'katahex-mcts-move': 'Bot move',
    'katahex-mcts-analyze-position': 'Position analysis',
    'katahex-mcts-analyze-move': 'Move analysis',
    'katahex-intuition-move': 'Bot move, intuition',
    'katahex-intuition-analyze-position': 'Position analysis, intuition',
    'katahex-intuition-analyze-game': 'Game analysis, intuition',
};

export const JOB_ICONS: Partial<Record<AiJobType, string>> = {
    'katahex-mcts-move': iconMove,
    'katahex-mcts-analyze-position': iconPosition,
    'katahex-mcts-analyze-move': iconAnalyzeMove,
    'katahex-intuition-move': iconIntuition,
    'katahex-intuition-analyze-position': iconIntuition,
    'katahex-intuition-analyze-game': iconIntuition,
};

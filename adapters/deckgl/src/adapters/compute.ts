import type { ComputeAdapter } from '@urban-toolkit/the-urban-grammar';

export function createComputeAdapter(): ComputeAdapter {
    return {
        async resolveCompute(): Promise<unknown> {
            throw new Error(
                'GPU compute (WGSL) is not supported in the deck.gl adapter. ' +
                'Use the AUTK adapter for compute operations, or pre-compute your data before passing it to the grammar.',
            );
        },
    };
}

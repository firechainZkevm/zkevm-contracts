// SPDX-License-Identifier: AGPL-3.0
pragma solidity 0.8.20;

import "../FirechainZkEVMGlobalExitRootL2.sol";

/**
 * Contract responsible for managing the exit roots across multiple networks

 */
contract FirechainZkEVMGlobalExitRootL2Mock is FirechainZkEVMGlobalExitRootL2 {
    /**
     * @param _bridgeAddress FirechainZkEVM Bridge contract address
     */
    constructor(
        address _bridgeAddress
    ) FirechainZkEVMGlobalExitRootL2(_bridgeAddress) {}

    /**
     * @notice Set globalExitRoot
     * @param globalExitRoot New global exit root
     * @param blockNumber block number
     */
    function setLastGlobalExitRoot(
        bytes32 globalExitRoot,
        uint256 blockNumber
    ) public {
        globalExitRootMap[globalExitRoot] = blockNumber;
    }

    /**
     * @notice Set rollup exit root
     * @param newRoot New rollup exit root
     */
    function setExitRoot(bytes32 newRoot) public {
        lastRollupExitRoot = newRoot;
    }
}

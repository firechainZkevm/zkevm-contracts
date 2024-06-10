// SPDX-License-Identifier: AGPL-3.0
pragma solidity 0.8.20;
import "../FirechainRollupManager.sol";
import "../interfaces/IFirechainRollupBase.sol";
import "../../lib/EmergencyManager.sol";

/**
 * FirechainRollupManager used only to test conensus contracts
 */
contract FirechainRollupManagerEmptyMock is EmergencyManager {
    uint256 currentSequenceBatches;

    bool acceptSequenceBatches = true;

    function setAcceptSequenceBatches(bool newAcceptSequenceBatches) public {
        acceptSequenceBatches = newAcceptSequenceBatches;
    }

    function onSequenceBatches(
        uint64 newSequencedBatches,
        bytes32 newAccInputHash
    ) external returns (uint64) {
        if (!acceptSequenceBatches) {
            revert();
        }
        currentSequenceBatches = currentSequenceBatches + newSequencedBatches;
        return uint64(currentSequenceBatches);
    }

    function onVerifyBatches(
        uint64 finalNewBatch,
        bytes32 newStateRoot,
        IFirechainRollupBase rollup
    ) external returns (uint64) {
        rollup.onVerifyBatches(finalNewBatch, newStateRoot, msg.sender);
    }

    function getBatchFee() public view returns (uint256) {
        return 1;
    }

    function getForcedBatchFee() public view returns (uint256) {
        return 10;
    }

    /**
     * @notice Function to deactivate emergency state on both FirechainZkEVM and FirechainZkEVMBridge contracts
     */
    function activateEmergencyState() external {
        // activate emergency state on this contract
        super._activateEmergencyState();
    }

    /**
     * @notice Function to deactivate emergency state on both FirechainZkEVM and FirechainZkEVMBridge contracts
     */
    function lastDeactivatedEmergencyStateTimestamp()
        external
        returns (uint256)
    {
        return 0;
    }

    /**
     * @notice Function to deactivate emergency state on both FirechainZkEVM and FirechainZkEVMBridge contracts
     */
    function deactivateEmergencyState() external {
        // Deactivate emergency state on this contract
        super._deactivateEmergencyState();
    }
}

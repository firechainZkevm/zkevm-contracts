// SPDX-License-Identifier: AGPL-3.0

pragma solidity 0.8.20;
import "./interfaces/IBaseFirechainZkEVMGlobalExitRoot.sol";

/**
 * Contract responsible for managing the exit roots for the L2 and global exit roots
 * The special zkRom variables will be accessed and updated directly by the zkRom
 */
contract FirechainZkEVMGlobalExitRootL2 is IBaseFirechainZkEVMGlobalExitRoot {
    /////////////////////////////
    // Special zkRom variables
    ////////////////////////////

    // Store every global exit root: Root --> timestamp
    // Note this variable is updated only by the zkRom
    mapping(bytes32 => uint256) public globalExitRootMap;

    // Rollup exit root will be updated for every FirechainZkEVMBridge call
    // Note this variable will be readed by the zkRom
    bytes32 public lastRollupExitRoot;

    ////////////////////
    // Regular variables
    ///////////////////

    // FirechainZkEVM Bridge address
    address public immutable bridgeAddress;

    /**
     * @param _bridgeAddress FirechainZkEVMBridge contract address
     */
    constructor(address _bridgeAddress) {
        bridgeAddress = _bridgeAddress;
    }

    /**
     * @notice Update the exit root of one of the networks and the global exit root
     * @param newRoot new exit tree root
     */
    function updateExitRoot(bytes32 newRoot) external {
        if (msg.sender != bridgeAddress) {
            revert OnlyAllowedContracts();
        }

        lastRollupExitRoot = newRoot;
    }
}

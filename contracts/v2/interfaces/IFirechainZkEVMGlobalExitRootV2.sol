// SPDX-License-Identifier: AGPL-3.0

pragma solidity ^0.8.20;
import "../../interfaces/IBaseFirechainZkEVMGlobalExitRoot.sol";

interface IFirechainZkEVMGlobalExitRootV2 is IBaseFirechainZkEVMGlobalExitRoot {
    function getLastGlobalExitRoot() external view returns (bytes32);

    function getRoot() external view returns (bytes32);
}

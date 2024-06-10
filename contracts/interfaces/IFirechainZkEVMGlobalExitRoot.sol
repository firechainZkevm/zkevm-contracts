// SPDX-License-Identifier: AGPL-3.0

pragma solidity ^0.8.20;
import "./IBaseFirechainZkEVMGlobalExitRoot.sol";

interface IFirechainZkEVMGlobalExitRoot is IBaseFirechainZkEVMGlobalExitRoot {
    function getLastGlobalExitRoot() external view returns (bytes32);
}

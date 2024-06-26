// SPDX-License-Identifier: AGPL-3.0
pragma solidity 0.8.20;
import "../FirechainZkEVMBridge.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * FirechainZkEVMBridge that will be deployed on both networks Ethereum and Firechain zkEVM
 * Contract responsible to manage the token interactions with other networks
 */
contract FirechainZkEVMBridgeMock is FirechainZkEVMBridge, OwnableUpgradeable {
    uint256 public maxEtherBridge;

    /**
     * @param _networkID networkID
     * @param _globalExitRootManager global exit root manager address
     */
    function initialize(
        uint32 _networkID,
        IBaseFirechainZkEVMGlobalExitRoot _globalExitRootManager,
        address _firechainZkEVMaddress
    ) public override initializer {
        networkID = _networkID;
        globalExitRootManager = _globalExitRootManager;
        firechainZkEVMaddress = _firechainZkEVMaddress;

        maxEtherBridge = 0.25 ether;

        // Initialize OZ contracts
        __Ownable_init_unchained();
    }

    function setNetworkID(uint32 _networkID) public onlyOwner {
        networkID = _networkID;
    }

    function setMaxEtherBridge(uint256 _maxEtherBridge) public onlyOwner {
        maxEtherBridge = _maxEtherBridge;
    }

    /**
     * @notice Deposit add a new leaf to the merkle tree
     * @param destinationNetwork Network destination
     * @param destinationAddress Address destination
     * @param amount Amount of tokens
     * @param token Token address, 0 address is reserved for ether
     * @param permitData Raw data of the call `permit` of the token
     */
    function bridgeAsset(
        uint32 destinationNetwork,
        address destinationAddress,
        uint256 amount,
        address token,
        bool forceUpdateGlobalExitRoot,
        bytes calldata permitData
    ) public payable override {
        require(
            msg.value <= maxEtherBridge,
            "FirechainZkEVMBridge::bridgeAsset: Cannot bridge more than maxEtherBridge"
        );
        super.bridgeAsset(
            destinationNetwork,
            destinationAddress,
            amount,
            token,
            forceUpdateGlobalExitRoot,
            permitData
        );
    }
}

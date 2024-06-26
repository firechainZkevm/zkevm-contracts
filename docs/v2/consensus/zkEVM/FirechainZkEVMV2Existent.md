Contract responsible for managing the states and the updates of L2 network.
There will be a trusted sequencer, which is able to send transactions.
Any user can force some transaction and the sequencer will have a timeout to add them in the queue.
The sequenced state is deterministic and can be precalculated before it's actually verified by a zkProof.
The aggregators will be able to verify the sequenced state with zkProofs and therefore make available the withdrawals from L2 network.
To enter and exit of the L2 network will be used a FirechainZkEVMBridge smart contract that will be deployed in both networks.


## Functions
### constructor
```solidity
  function constructor(
    contract IFirechainZkEVMGlobalExitRoot _globalExitRootManager,
    contract IERC20Upgradeable _pol,
    contract IFirechainZkEVMBridge _bridgeAddress,
    contract FirechainRollupManager _rollupManager
  ) public
```


#### Parameters:
| Name | Type | Description                                                          |
| :--- | :--- | :------------------------------------------------------------------- |
|`_globalExitRootManager` | contract IFirechainZkEVMGlobalExitRoot | Global exit root manager address
|`_pol` | contract IERC20Upgradeable | POL token address
|`_bridgeAddress` | contract IFirechainZkEVMBridge | Bridge address
|`_rollupManager` | contract FirechainRollupManager | Global exit root manager address

### initializeUpgrade
```solidity
  function initializeUpgrade(
    address _admin,
    address _trustedSequencer,
    string _trustedSequencerURL,
    string _networkName,
    bytes32 _lastAccInputHash,
    uint64 _lastTimestamp
  ) external
```
note This initializer will be called instead of the FirechainRollupBase
This is a especial initializer since the zkEVM it's an already created network


#### Parameters:
| Name | Type | Description                                                          |
| :--- | :--- | :------------------------------------------------------------------- |
|`_admin` | address | Admin address
|`_trustedSequencer` | address | Trusted sequencer address
|`_trustedSequencerURL` | string | Trusted sequencer URL
|`_networkName` | string | L2 network name
|`_lastAccInputHash` | bytes32 | Acc input hash
|`_lastTimestamp` | uint64 | Timestamp


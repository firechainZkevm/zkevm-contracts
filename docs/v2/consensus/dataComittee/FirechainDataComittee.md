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

### sequenceBatches
```solidity
  function sequenceBatches(
  ) public
```




### sequenceBatchesDataCommittee
```solidity
  function sequenceBatchesDataCommittee(
    struct FirechainDataComittee.ValidiumBatchData[] batches,
    address l2Coinbase,
    bytes dataAvailabilityMessage
  ) external
```
Allows a sequencer to send multiple batches


#### Parameters:
| Name | Type | Description                                                          |
| :--- | :--- | :------------------------------------------------------------------- |
|`batches` | struct FirechainDataComittee.ValidiumBatchData[] | Struct array which holds the necessary data to append new batches to the sequence
|`l2Coinbase` | address | Address that will receive the fees from L2
|`dataAvailabilityMessage` | bytes | Byte array containing the signatures and all the addresses of the committee in ascending order
[signature 0, ..., signature requiredAmountOfSignatures -1, address 0, ... address N]
note that each ECDSA signatures are used, therefore each one must be 65 bytes

### switchSequenceWithDataAvailability
```solidity
  function switchSequenceWithDataAvailability(
  ) external
```
Allow the admin to turn on the force batches
This action is not reversible



## Events
### SwitchSequenceWithDataAvailability
```solidity
  event SwitchSequenceWithDataAvailability(
  )
```

Emitted when switch the ability to sequence with data availability


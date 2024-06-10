/* eslint-disable no-plusplus, no-await-in-loop */
const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

describe('FirechainZkEVMUpgraded', () => {
    let deployer;
    let trustedAggregator;
    let trustedSequencer;
    let admin;
    let aggregator1;

    let verifierContract;
    let firechainZkEVMBridgeContract;
    let firechainZkEVMContract;
    let maticTokenContract;
    let firechainZkEVMGlobalExitRoot;

    const maticTokenName = 'Matic Token';
    const maticTokenSymbol = 'MATIC';
    const maticTokenInitialBalance = ethers.parseEther('20000000');

    const genesisRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';

    const networkIDMainnet = 0;
    const urlSequencer = 'http://zkevm-json-rpc:8123';
    const chainID = 1000;
    const networkName = 'zkevm';
    const version = '0.0.1';
    const forkID = 0;
    const pendingStateTimeoutDefault = 100;
    const trustedAggregatorTimeoutDefault = 10;
    let firstDeployment = true;
    const currentVersion = 0;

    // FirechainZkEVM Constants
    const FORCE_BATCH_TIMEOUT = 60 * 60 * 24 * 5; // 5 days

    beforeEach('Deploy contract', async () => {
        upgrades.silenceWarnings();

        // load signers
        [deployer, trustedAggregator, trustedSequencer, admin, aggregator1] = await ethers.getSigners();

        // deploy mock verifier
        const VerifierRollupHelperFactory = await ethers.getContractFactory(
            'VerifierRollupHelperMock',
        );
        verifierContract = await VerifierRollupHelperFactory.deploy();

        // deploy MATIC
        const maticTokenFactory = await ethers.getContractFactory('ERC20PermitMock');
        maticTokenContract = await maticTokenFactory.deploy(
            maticTokenName,
            maticTokenSymbol,
            deployer.address,
            maticTokenInitialBalance,
        );
        await maticTokenContract.deployed();

        /*
         * deploy global exit root manager
         * In order to not have trouble with nonce deploy first proxy admin
         */
        await upgrades.deployProxyAdmin();
        if ((await upgrades.admin.getInstance()).address !== '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0') {
            firstDeployment = false;
        }
        const nonceProxyBridge = Number((await ethers.provider.getTransactionCount(deployer.address))) + (firstDeployment ? 3 : 2);
        const nonceProxyZkevm = nonceProxyBridge + 2; // Always have to redeploy impl since the firechainZkEVMGlobalExitRoot address changes

        const precalculateBridgeAddress = ethers.getContractAddress({ from: deployer.address, nonce: nonceProxyBridge });
        const precalculateZkevmAddress = ethers.getContractAddress({ from: deployer.address, nonce: nonceProxyZkevm });
        firstDeployment = false;

        const FirechainZkEVMGlobalExitRootFactory = await ethers.getContractFactory('FirechainZkEVMGlobalExitRoot');
        firechainZkEVMGlobalExitRoot = await upgrades.deployProxy(FirechainZkEVMGlobalExitRootFactory, [], {
            initializer: false,
            constructorArgs: [precalculateZkevmAddress, precalculateBridgeAddress],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        // deploy FirechainZkEVMBridge
        const firechainZkEVMBridgeFactory = await ethers.getContractFactory('FirechainZkEVMBridge');
        firechainZkEVMBridgeContract = await upgrades.deployProxy(firechainZkEVMBridgeFactory, [], { initializer: false });

        // deploy FirechainZkEVMTestnet
        const FirechainZkEVMFactory = await ethers.getContractFactory('FirechainZkEVMUpgraded');
        firechainZkEVMContract = await upgrades.deployProxy(FirechainZkEVMFactory, [], {
            initializer: false,
            constructorArgs: [
                firechainZkEVMGlobalExitRoot.address,
                maticTokenContract.address,
                verifierContract.address,
                firechainZkEVMBridgeContract.address,
                chainID,
                forkID,
                currentVersion,
            ],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        expect(precalculateBridgeAddress).to.be.equal(firechainZkEVMBridgeContract.address);
        expect(precalculateZkevmAddress).to.be.equal(firechainZkEVMContract.address);

        await firechainZkEVMBridgeContract.initialize(networkIDMainnet, firechainZkEVMGlobalExitRoot.address, firechainZkEVMContract.address);
        await firechainZkEVMContract.initialize(
            {
                admin: admin.address,
                trustedSequencer: trustedSequencer.address,
                pendingStateTimeout: pendingStateTimeoutDefault,
                trustedAggregator: trustedAggregator.address,
                trustedAggregatorTimeout: trustedAggregatorTimeoutDefault,
            },
            genesisRoot,
            urlSequencer,
            networkName,
            version,
        );

        // fund sequencer address with Matic tokens
        await maticTokenContract.transfer(trustedSequencer.address, ethers.parseEther('1000'));
    });

    it('should check the constructor parameters', async () => {
        expect(await firechainZkEVMContract.version()).to.be.equal(0);
    });

    it('should check updateVersion', async () => {
        const newVersionString = '0.0.2';

        const lastVerifiedBatch = 0;
        await expect(firechainZkEVMContract.updateVersion(newVersionString))
            .to.emit(firechainZkEVMContract, 'UpdateZkEVMVersion').withArgs(lastVerifiedBatch, forkID, newVersionString);

        expect(await firechainZkEVMContract.version()).to.be.equal(1);

        await expect(firechainZkEVMContract.updateVersion(newVersionString))
            .to.be.revertedWith('VersionAlreadyUpdated');
    });

    it('should upgrade firechainKEVM', async () => {
        // deploy FirechainZkEVMTestnet
        const FirechainZkEVMFactory = await ethers.getContractFactory('FirechainZkEVM');
        const oldFirechainZkEVMContract = await upgrades.deployProxy(FirechainZkEVMFactory, [], {
            initializer: false,
            constructorArgs: [
                firechainZkEVMGlobalExitRoot.address,
                maticTokenContract.address,
                verifierContract.address,
                firechainZkEVMBridgeContract.address,
                chainID,
                forkID,
            ],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        // initialize
        await oldFirechainZkEVMContract.initialize(
            {
                admin: admin.address,
                trustedSequencer: trustedSequencer.address,
                pendingStateTimeout: pendingStateTimeoutDefault,
                trustedAggregator: trustedAggregator.address,
                trustedAggregatorTimeout: trustedAggregatorTimeoutDefault,
            },
            genesisRoot,
            urlSequencer,
            networkName,
            version,
        );

        /*
         * Upgrade the contract
         */
        const FirechainZkEVMUpgradedFactory = await ethers.getContractFactory('FirechainZkEVMUpgraded');
        const firechainZkEVMUpgradedContract = FirechainZkEVMUpgradedFactory.attach(oldFirechainZkEVMContract.address);

        // Check that is the v0 contract
        await expect(firechainZkEVMUpgradedContract.version()).to.be.reverted;

        // Upgrade the contract
        const newVersionString = '0.0.2';

        await upgrades.upgradeProxy(
            firechainZkEVMContract.address,
            FirechainZkEVMUpgradedFactory,
            {
                constructorArgs: [
                    firechainZkEVMGlobalExitRoot.address,
                    maticTokenContract.address,
                    verifierContract.address,
                    firechainZkEVMBridgeContract.address,
                    chainID,
                    forkID,
                    currentVersion],
                unsafeAllow: ['constructor', 'state-variable-immutable'],
                call: { fn: 'updateVersion', args: [newVersionString] },
            },
        );

        expect(await firechainZkEVMContract.version()).to.be.equal(1);
        await expect(firechainZkEVMContract.updateVersion(newVersionString))
            .to.be.revertedWith('VersionAlreadyUpdated');
    });

    it('should check the constructor parameters', async () => {
        expect(await firechainZkEVMContract.globalExitRootManager()).to.be.equal(firechainZkEVMGlobalExitRoot.address);
        expect(await firechainZkEVMContract.matic()).to.be.equal(maticTokenContract.address);
        expect(await firechainZkEVMContract.rollupVerifier()).to.be.equal(verifierContract.address);
        expect(await firechainZkEVMContract.bridgeAddress()).to.be.equal(firechainZkEVMBridgeContract.address);

        expect(await firechainZkEVMContract.owner()).to.be.equal(deployer.address);
        expect(await firechainZkEVMContract.admin()).to.be.equal(admin.address);
        expect(await firechainZkEVMContract.chainID()).to.be.equal(chainID);
        expect(await firechainZkEVMContract.trustedSequencer()).to.be.equal(trustedSequencer.address);
        expect(await firechainZkEVMContract.pendingStateTimeout()).to.be.equal(pendingStateTimeoutDefault);
        expect(await firechainZkEVMContract.trustedAggregator()).to.be.equal(trustedAggregator.address);
        expect(await firechainZkEVMContract.trustedAggregatorTimeout()).to.be.equal(trustedAggregatorTimeoutDefault);

        expect(await firechainZkEVMContract.batchNumToStateRoot(0)).to.be.equal(genesisRoot);
        expect(await firechainZkEVMContract.trustedSequencerURL()).to.be.equal(urlSequencer);
        expect(await firechainZkEVMContract.networkName()).to.be.equal(networkName);

        expect(await firechainZkEVMContract.batchFee()).to.be.equal(ethers.parseEther('0.1'));
        expect(await firechainZkEVMContract.batchFee()).to.be.equal(ethers.parseEther('0.1'));
        expect(await firechainZkEVMContract.getForcedBatchFee()).to.be.equal(ethers.parseEther('10'));

        expect(await firechainZkEVMContract.forceBatchTimeout()).to.be.equal(FORCE_BATCH_TIMEOUT);
        expect(await firechainZkEVMContract.isForcedBatchDisallowed()).to.be.equal(true);
    });

    it('Test overridePendingState properly', async () => {
        const l2txData = '0x123456';
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const batchesForSequence = 5;
        const sequence = {
            transactions: l2txData,
            globalExitRoot: ethers.HashZero,
            timestamp: currentTimestamp,
            minForcedTimestamp: 0,
        };
        const sequencesArray = Array(batchesForSequence).fill(sequence);
        // Array(5).fill("girl", 0);

        // Approve lots of tokens
        await expect(
            maticTokenContract.connect(trustedSequencer).approve(firechainZkEVMContract.address, maticTokenInitialBalance),
        ).to.emit(maticTokenContract, 'Approval');

        // Make 20 sequences of 5 batches, with 1 minut timestamp difference
        for (let i = 0; i < 20; i++) {
            await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches(sequencesArray, trustedSequencer.address))
                .to.emit(firechainZkEVMContract, 'SequenceBatches');
        }
        await ethers.provider.send('evm_increaseTime', [60]);

        // Forge first sequence with verifyBAtches
        const newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';
        const newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000000002';
        const zkProofFFlonk = new Array(24).fill(ethers.HashZero);

        let currentPendingState = 0;
        let currentNumBatch = 0;
        let newBatch = currentNumBatch + batchesForSequence;

        // Verify batch 2 batches
        await expect(
            firechainZkEVMContract.connect(aggregator1).verifyBatches(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(firechainZkEVMContract, 'VerifyBatches')
            .withArgs(newBatch, newStateRoot, aggregator1.address);

        // verify second sequence
        currentPendingState++;
        currentNumBatch = newBatch;
        newBatch += batchesForSequence;
        await expect(
            firechainZkEVMContract.connect(aggregator1).verifyBatches(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(firechainZkEVMContract, 'VerifyBatches')
            .withArgs(newBatch, newStateRoot, aggregator1.address);

        const finalPendingState = 2;

        await expect(
            firechainZkEVMContract.connect(aggregator1).overridePendingState(
                currentPendingState,
                finalPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('OnlyTrustedAggregator');

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).overridePendingState(
                finalPendingState + 1,
                finalPendingState + 2,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('PendingStateDoesNotExist');

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).overridePendingState(
                currentPendingState,
                finalPendingState,
                currentNumBatch + 1,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('InitNumBatchDoesNotMatchPendingState');

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).overridePendingState(
                currentPendingState,
                finalPendingState,
                currentNumBatch,
                newBatch + 1,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('FinalNumBatchDoesNotMatchPendingState');

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).overridePendingState(
                0,
                finalPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('OldStateRootDoesNotExist');

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).overridePendingState(
                finalPendingState,
                finalPendingState,
                currentNumBatch + 5,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('FinalPendingStateNumInvalid');

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).overridePendingState(
                finalPendingState,
                finalPendingState + 2,
                currentNumBatch + 5,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('FinalPendingStateNumInvalid');

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).overridePendingState(
                currentPendingState,
                finalPendingState,
                currentNumBatch,
                newBatch + 1,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('FinalNumBatchDoesNotMatchPendingState');

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).overridePendingState(
                currentPendingState,
                finalPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('StoredRootMustBeDifferentThanNewRoot');

        const newStateRoot2 = '0x0000000000000000000000000000000000000000000000000000000000000003';
        await expect(
            firechainZkEVMContract.connect(trustedAggregator).overridePendingState(
                currentPendingState,
                finalPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot2,
                zkProofFFlonk,
            ),
        ).to.emit(firechainZkEVMContract, 'OverridePendingState').withArgs(newBatch, newStateRoot2, trustedAggregator.address);

        // check pending state is clear
        currentPendingState = 0;
        expect(currentPendingState).to.be.equal(await firechainZkEVMContract.lastPendingState());
        expect(0).to.be.equal(await firechainZkEVMContract.lastPendingStateConsolidated());

        // check consolidated state
        const currentVerifiedBatch = newBatch;
        expect(currentVerifiedBatch).to.be.equal(await firechainZkEVMContract.lastVerifiedBatch());
        expect(newStateRoot2).to.be.equal(await firechainZkEVMContract.batchNumToStateRoot(currentVerifiedBatch));
    });

    it('Test overridePendingState fails cause was last forkID', async () => {
        const l2txData = '0x123456';
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const batchesForSequence = 5;
        const sequence = {
            transactions: l2txData,
            globalExitRoot: ethers.HashZero,
            timestamp: currentTimestamp,
            minForcedTimestamp: 0,
        };
        const sequencesArray = Array(batchesForSequence).fill(sequence);
        // Array(5).fill("girl", 0);

        // Approve lots of tokens
        await expect(
            maticTokenContract.connect(trustedSequencer).approve(firechainZkEVMContract.address, maticTokenInitialBalance),
        ).to.emit(maticTokenContract, 'Approval');

        // Make 20 sequences of 5 batches, with 1 minut timestamp difference
        for (let i = 0; i < 20; i++) {
            await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches(sequencesArray, trustedSequencer.address))
                .to.emit(firechainZkEVMContract, 'SequenceBatches');
        }
        await ethers.provider.send('evm_increaseTime', [60]);

        // Forge first sequence with verifyBAtches
        const newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';
        const newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000000002';
        const zkProofFFlonk = new Array(24).fill(ethers.HashZero);

        let currentPendingState = 0;
        let currentNumBatch = 0;
        let newBatch = currentNumBatch + batchesForSequence;

        // Verify batch 2 batches
        await expect(
            firechainZkEVMContract.connect(aggregator1).verifyBatches(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(firechainZkEVMContract, 'VerifyBatches')
            .withArgs(newBatch, newStateRoot, aggregator1.address);

        // verify second sequence
        currentPendingState++;
        currentNumBatch = newBatch;
        newBatch += batchesForSequence;
        await expect(
            firechainZkEVMContract.connect(aggregator1).verifyBatches(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(firechainZkEVMContract, 'VerifyBatches')
            .withArgs(newBatch, newStateRoot, aggregator1.address);

        const finalPendingState = 2;

        const consolidatedBatch = batchesForSequence;
        await expect(
            firechainZkEVMContract.connect(trustedAggregator).consolidatePendingState(
                1, // pending state num
            ),
        ).to.emit(firechainZkEVMContract, 'ConsolidatePendingState')
            .withArgs(consolidatedBatch, newStateRoot, 1);

        // Upgrade the contract
        const newVersionString = '0.0.3';
        await expect(firechainZkEVMContract.updateVersion(newVersionString))
            .to.emit(firechainZkEVMContract, 'UpdateZkEVMVersion').withArgs(consolidatedBatch, forkID, newVersionString);

        const newStateRoot2 = '0x0000000000000000000000000000000000000000000000000000000000000003';
        await expect(
            firechainZkEVMContract.connect(trustedAggregator).overridePendingState(
                0,
                finalPendingState,
                0,
                newBatch,
                newLocalExitRoot,
                newStateRoot2,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('InitBatchMustMatchCurrentForkID');
    });

    it('Test overridePendingState fails cause was last forkID2', async () => {
        const l2txData = '0x123456';
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const batchesForSequence = 5;
        const sequence = {
            transactions: l2txData,
            globalExitRoot: ethers.HashZero,
            timestamp: currentTimestamp,
            minForcedTimestamp: 0,
        };
        const sequencesArray = Array(batchesForSequence).fill(sequence);
        // Array(5).fill("girl", 0);

        // Approve lots of tokens
        await expect(
            maticTokenContract.connect(trustedSequencer).approve(firechainZkEVMContract.address, maticTokenInitialBalance),
        ).to.emit(maticTokenContract, 'Approval');

        // Make 20 sequences of 5 batches, with 1 minut timestamp difference
        for (let i = 0; i < 20; i++) {
            await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches(sequencesArray, trustedSequencer.address))
                .to.emit(firechainZkEVMContract, 'SequenceBatches');
        }
        await ethers.provider.send('evm_increaseTime', [60]);

        // Forge first sequence with verifyBAtches
        const newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';
        const newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000000002';
        const zkProofFFlonk = new Array(24).fill(ethers.HashZero);

        let currentPendingState = 0;
        let currentNumBatch = 0;
        let newBatch = currentNumBatch + batchesForSequence;

        // Verify batch 2 batches
        await expect(
            firechainZkEVMContract.connect(aggregator1).verifyBatches(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(firechainZkEVMContract, 'VerifyBatches')
            .withArgs(newBatch, newStateRoot, aggregator1.address);

        // verify second sequence
        currentPendingState++;
        currentNumBatch = newBatch;
        newBatch += batchesForSequence;
        await expect(
            firechainZkEVMContract.connect(aggregator1).verifyBatches(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(firechainZkEVMContract, 'VerifyBatches')
            .withArgs(newBatch, newStateRoot, aggregator1.address);

        const finalPendingState = 2;

        const consolidatedBatch = batchesForSequence;
        await expect(
            firechainZkEVMContract.connect(trustedAggregator).consolidatePendingState(
                1, // pending state num
            ),
        ).to.emit(firechainZkEVMContract, 'ConsolidatePendingState')
            .withArgs(consolidatedBatch, newStateRoot, 1);

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).consolidatePendingState(
                finalPendingState, // pending state num
            ),
        ).to.emit(firechainZkEVMContract, 'ConsolidatePendingState')
            .withArgs(newBatch, newStateRoot, finalPendingState);

        // Upgrade the contract
        const newVersionString = '0.0.3';
        const updatedBatch = newBatch;
        await expect(firechainZkEVMContract.updateVersion(newVersionString))
            .to.emit(firechainZkEVMContract, 'UpdateZkEVMVersion').withArgs(updatedBatch, forkID, newVersionString);

        // verify second sequence
        currentPendingState++;
        currentNumBatch = newBatch;
        newBatch += batchesForSequence;
        await expect(
            firechainZkEVMContract.connect(aggregator1).verifyBatches(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(firechainZkEVMContract, 'VerifyBatches')
            .withArgs(newBatch, newStateRoot, aggregator1.address);

        const newStateRoot2 = '0x0000000000000000000000000000000000000000000000000000000000000003';
        await expect(
            firechainZkEVMContract.connect(trustedAggregator).overridePendingState(
                0,
                currentPendingState,
                consolidatedBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot2,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('InitBatchMustMatchCurrentForkID');

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).overridePendingState(
                0,
                currentPendingState,
                updatedBatch - 1,
                newBatch,
                newLocalExitRoot,
                newStateRoot2,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('InitBatchMustMatchCurrentForkID');

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                0,
                updatedBatch - 1,
                newBatch,
                newLocalExitRoot,
                newStateRoot2,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('InitBatchMustMatchCurrentForkID');
    });
});

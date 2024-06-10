/* eslint-disable no-plusplus, no-await-in-loop */
const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

const { contractUtils } = require('@0xpolygonhermez/zkevm-commonjs');

const { calculateSnarkInput, calculateAccInputHash, calculateBatchHashData } = contractUtils;

describe('Firechain ZK-EVM', () => {
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

    // FirechainZkEVM Constants
    const FORCE_BATCH_TIMEOUT = 60 * 60 * 24 * 5; // 5 days
    const MAX_BATCH_MULTIPLIER = 12;
    const HALT_AGGREGATION_TIMEOUT = 60 * 60 * 24 * 7; // 7 days
    const _MAX_VERIFY_BATCHES = 1000;
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

        // deploy FirechainZkEVMMock
        const FirechainZkEVMFactory = await ethers.getContractFactory('FirechainZkEVMMock');
        firechainZkEVMContract = await upgrades.deployProxy(FirechainZkEVMFactory, [], {
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

    it('should check initialize function', async () => {
        const FirechainZkEVMFactory = await ethers.getContractFactory('FirechainZkEVMMock');
        const firechainZkEVMContractInitialize = await upgrades.deployProxy(FirechainZkEVMFactory, [], {
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

        await expect(firechainZkEVMContractInitialize.initialize(
            {
                admin: admin.address,
                trustedSequencer: trustedSequencer.address,
                pendingStateTimeout: HALT_AGGREGATION_TIMEOUT + 1,
                trustedAggregator: trustedAggregator.address,
                trustedAggregatorTimeout: trustedAggregatorTimeoutDefault,
            },
            genesisRoot,
            urlSequencer,
            networkName,
            version,
        )).to.be.revertedWith('PendingStateTimeoutExceedHaltAggregationTimeout');

        await expect(firechainZkEVMContractInitialize.initialize(
            {
                admin: admin.address,
                trustedSequencer: trustedSequencer.address,
                pendingStateTimeout: pendingStateTimeoutDefault,
                trustedAggregator: trustedAggregator.address,
                trustedAggregatorTimeout: HALT_AGGREGATION_TIMEOUT + 1,
            },
            genesisRoot,
            urlSequencer,
            networkName,
            version,
        )).to.be.revertedWith('TrustedAggregatorTimeoutExceedHaltAggregationTimeout');

        await expect(
            firechainZkEVMContractInitialize.initialize(
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
            ),
        ).to.emit(firechainZkEVMContractInitialize, 'UpdateZkEVMVersion').withArgs(0, forkID, version);
    });

    it('should check setters of admin', async () => {
        expect(await firechainZkEVMContract.trustedSequencer()).to.be.equal(trustedSequencer.address);
        expect(await firechainZkEVMContract.trustedSequencerURL()).to.be.equal(urlSequencer);
        expect(await firechainZkEVMContract.trustedAggregator()).to.be.equal(trustedAggregator.address);
        expect(await firechainZkEVMContract.trustedAggregatorTimeout()).to.be.equal(trustedAggregatorTimeoutDefault);
        expect(await firechainZkEVMContract.pendingStateTimeout()).to.be.equal(pendingStateTimeoutDefault);
        expect(await firechainZkEVMContract.admin()).to.be.equal(admin.address);

        // setTrustedSequencer
        await expect(firechainZkEVMContract.setTrustedSequencer(deployer.address))
            .to.be.revertedWith('OnlyAdmin');
        await expect(
            firechainZkEVMContract.connect(admin).setTrustedSequencer(deployer.address),
        ).to.emit(firechainZkEVMContract, 'SetTrustedSequencer').withArgs(deployer.address);
        expect(await firechainZkEVMContract.trustedSequencer()).to.be.equal(deployer.address);

        // setTrustedSequencerURL
        const url = 'https://test';
        await expect(firechainZkEVMContract.setTrustedSequencerURL(url))
            .to.be.revertedWith('OnlyAdmin');
        await expect(
            firechainZkEVMContract.connect(admin).setTrustedSequencerURL(url),
        ).to.emit(firechainZkEVMContract, 'SetTrustedSequencerURL').withArgs(url);
        expect(await firechainZkEVMContract.trustedSequencerURL()).to.be.equal(url);

        // setTrustedAggregator
        const newTrustedAggregator = deployer.address;
        await expect(firechainZkEVMContract.setTrustedAggregator(newTrustedAggregator))
            .to.be.revertedWith('OnlyAdmin');
        await expect(
            firechainZkEVMContract.connect(admin).setTrustedAggregator(newTrustedAggregator),
        ).to.emit(firechainZkEVMContract, 'SetTrustedAggregator').withArgs(newTrustedAggregator);
        expect(await firechainZkEVMContract.trustedAggregator()).to.be.equal(newTrustedAggregator);

        // setTrustedAggregatorTimeout
        await expect(firechainZkEVMContract.setTrustedAggregatorTimeout(trustedAggregatorTimeoutDefault))
            .to.be.revertedWith('OnlyAdmin');

        await expect(firechainZkEVMContract.connect(admin).setTrustedAggregatorTimeout(HALT_AGGREGATION_TIMEOUT + 1))
            .to.be.revertedWith('TrustedAggregatorTimeoutExceedHaltAggregationTimeout');

        await expect(firechainZkEVMContract.connect(admin).setTrustedAggregatorTimeout(trustedAggregatorTimeoutDefault))
            .to.be.revertedWith('NewTrustedAggregatorTimeoutMustBeLower');

        const newTrustedAggregatorTimeout = trustedAggregatorTimeoutDefault - 1;
        await expect(
            firechainZkEVMContract.connect(admin).setTrustedAggregatorTimeout(newTrustedAggregatorTimeout),
        ).to.emit(firechainZkEVMContract, 'SetTrustedAggregatorTimeout').withArgs(newTrustedAggregatorTimeout);
        expect(await firechainZkEVMContract.trustedAggregatorTimeout()).to.be.equal(newTrustedAggregatorTimeout);

        // setPendingStateTimeoutDefault
        await expect(firechainZkEVMContract.setPendingStateTimeout(pendingStateTimeoutDefault))
            .to.be.revertedWith('OnlyAdmin');

        await expect(firechainZkEVMContract.connect(admin).setPendingStateTimeout(HALT_AGGREGATION_TIMEOUT + 1))
            .to.be.revertedWith('PendingStateTimeoutExceedHaltAggregationTimeout');

        await expect(firechainZkEVMContract.connect(admin).setPendingStateTimeout(pendingStateTimeoutDefault))
            .to.be.revertedWith('NewPendingStateTimeoutMustBeLower');

        const newPendingStateTimeoutDefault = pendingStateTimeoutDefault - 1;
        await expect(
            firechainZkEVMContract.connect(admin).setPendingStateTimeout(newPendingStateTimeoutDefault),
        ).to.emit(firechainZkEVMContract, 'SetPendingStateTimeout').withArgs(newPendingStateTimeoutDefault);
        expect(await firechainZkEVMContract.pendingStateTimeout()).to.be.equal(newPendingStateTimeoutDefault);

        // setMultiplierBatchFee
        const newMultiplierBatchFee = 1023;
        await expect(firechainZkEVMContract.connect(admin).setMultiplierBatchFee(newMultiplierBatchFee + 1))
            .to.be.revertedWith('InvalidRangeMultiplierBatchFee');

        await expect(
            firechainZkEVMContract.connect(admin).setMultiplierBatchFee(newMultiplierBatchFee),
        ).to.emit(firechainZkEVMContract, 'SetMultiplierBatchFee').withArgs(newMultiplierBatchFee);
        expect(await firechainZkEVMContract.multiplierBatchFee()).to.be.equal(newMultiplierBatchFee);

        // setVerifyBatchTimeTarget
        const newVerifyBatchTimeTarget = 100;

        await expect(firechainZkEVMContract.connect(admin).setVerifyBatchTimeTarget(60 * 60 * 24 + 1)) // more than 1 day
            .to.be.revertedWith('InvalidRangeBatchTimeTarget');

        await expect(
            firechainZkEVMContract.connect(admin).setVerifyBatchTimeTarget(newVerifyBatchTimeTarget),
        ).to.emit(firechainZkEVMContract, 'SetVerifyBatchTimeTarget').withArgs(newVerifyBatchTimeTarget);
        expect(await firechainZkEVMContract.verifyBatchTimeTarget()).to.be.equal(newVerifyBatchTimeTarget);

        // setPendingStateTimeoutDefault
        const newForceBatchTimeout = 0;
        await expect(firechainZkEVMContract.setForceBatchTimeout(newForceBatchTimeout))
            .to.be.revertedWith('OnlyAdmin');

        await expect(firechainZkEVMContract.connect(admin).setForceBatchTimeout(HALT_AGGREGATION_TIMEOUT + 1))
            .to.be.revertedWith('InvalidRangeForceBatchTimeout');

        await expect(firechainZkEVMContract.connect(admin).setForceBatchTimeout(FORCE_BATCH_TIMEOUT))
            .to.be.revertedWith('InvalidRangeForceBatchTimeout');
        await expect(
            firechainZkEVMContract.connect(admin).setForceBatchTimeout(newForceBatchTimeout),
        ).to.emit(firechainZkEVMContract, 'SetForceBatchTimeout').withArgs(newForceBatchTimeout);
        expect(await firechainZkEVMContract.forceBatchTimeout()).to.be.equal(newForceBatchTimeout);

        // Activate force batches
        await expect(firechainZkEVMContract.activateForceBatches())
            .to.be.revertedWith('OnlyAdmin');

        // Check force batches are unactive
        await expect(firechainZkEVMContract.forceBatch('0x', 0))
            .to.be.revertedWith('ForceBatchNotAllowed');
        await expect(firechainZkEVMContract.sequenceForceBatches([]))
            .to.be.revertedWith('ForceBatchNotAllowed');

        await expect(
            firechainZkEVMContract.connect(admin).activateForceBatches(),
        ).to.emit(firechainZkEVMContract, 'ActivateForceBatches');
        await expect(firechainZkEVMContract.connect(admin).activateForceBatches())
            .to.be.revertedWith('ForceBatchesAlreadyActive');

        expect(await firechainZkEVMContract.isForcedBatchDisallowed()).to.be.equal(false);

        // Transfer admin role

        // First set pending Admin
        expect(await firechainZkEVMContract.pendingAdmin()).to.be.equal(ethers.ZeroAddress);
        await expect(firechainZkEVMContract.transferAdminRole(deployer.address))
            .to.be.revertedWith('OnlyAdmin');

        await expect(
            firechainZkEVMContract.connect(admin).transferAdminRole(deployer.address),
        ).to.emit(firechainZkEVMContract, 'TransferAdminRole').withArgs(deployer.address);
        expect(await firechainZkEVMContract.pendingAdmin()).to.be.equal(deployer.address);

        // Accept transfer admin
        expect(await firechainZkEVMContract.admin()).to.be.equal(admin.address);
        await expect(firechainZkEVMContract.connect(admin).acceptAdminRole())
            .to.be.revertedWith('OnlyPendingAdmin');

        await expect(
            firechainZkEVMContract.connect(deployer).acceptAdminRole(),
        ).to.emit(firechainZkEVMContract, 'AcceptAdminRole').withArgs(deployer.address);
        expect(await firechainZkEVMContract.admin()).to.be.equal(deployer.address);
    });

    it('should check state roots inside prime', async () => {
        const validRoots = [
            '0x02959FFA45214AF690A3730806D4F59F7056CCC449373BBE42C20765D3996CA1',
            '0x7E680781BF155C4682C7D431E86DAFD1DD986BE664A7256879CB2B33391E2DAC',
            '0xD710F3A64598F4C6C94E2A5F3F6193B4FBADBF5A5DBAFEBD0A75277E27E2BCD3',
            '0x048F3F2D4430DAF38E3CC891853C9BB102E5880E1ADA799554C7ED392B4BD7F3',
            '0x7E680781BF155C4682C7D431E86DAFD1DD986BE664A7256879CB2B33391E2DAC',
            '0xFFFFFFFE45214AF690A3730806D4F59F7056CCC449373BBE42C20765D3996CA1',
            '0x7E680781BF155C4FFFFFFFF1E86DAFD1DD986BE664A7256879CB2B33391E2DAC',
            '0xFFFFFFFF00000000C94E2A5F3F6193B4FBADBF5A5DBAFEBD0A75277E27E2BCD3',
            '0x048F3F2D4430DAF3FFFFFFFF0000000002E5880E1ADA799554C7ED392B4BD7F3',
            '0x7E680781BF155C4682C7D431E86DAFD1FFFFFFFF0000000079CB2B33391E2DAC',
            '0x02959FFA45214AF690A3730806D4F59F7056CCC449373BBEFFFFFFFF00000000',
            '0xFFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000',
        ];

        const aliasInvalidRoots = ['0xFFFFFFFF45214AF690A3730806D4F59F7056CCC449373BBE42C20765D3996CA1',
            '0x7E680781BF155C46FFFFFFFFE86DAFD1DD986BE664A7256879CB2B33391E2DAC',
            '0xD710F3A64598F4C6C94E2A5F3F6193B4FFFFFFFF5DBAFEBD0A75277E27E2BCD3',
            '0x048F3F2D4430DAF38E3CC891853C9BB102E5880E1ADA7995FFFFFFFF2B4BD7F3',
            '0xFFFFFFFFBF155C4682C7D431E86DAFD1FFFFFFFF64A7256879CB2B33391E2DAC',
        ];

        for (let i = 0; i < validRoots.length; i++) {
            expect(await firechainZkEVMContract.checkStateRootInsidePrime(validRoots[i])).to.be.equal(true);
        }

        for (let i = 0; i < aliasInvalidRoots.length; i++) {
            expect(await firechainZkEVMContract.checkStateRootInsidePrime(aliasInvalidRoots[i])).to.be.equal(false);
        }
    });

    it('should sequence a batch as trusted sequencer', async () => {
        const l2txData = '0x123456';
        const maticAmount = await firechainZkEVMContract.batchFee();
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const sequence = {
            transactions: l2txData,
            globalExitRoot: ethers.HashZero,
            timestamp: ethers.BigNumber.from(currentTimestamp),
            minForcedTimestamp: 0,
        };

        // revert because sender is not truested sequencer
        await expect(firechainZkEVMContract.sequenceBatches([sequence], trustedSequencer.address))
            .to.be.revertedWith('OnlyTrustedSequencer');

        // revert because tokens were not approved
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([sequence], trustedSequencer.address))
            .to.be.revertedWith('ERC20: insufficient allowance');

        const initialOwnerBalance = await maticTokenContract.balanceOf(
            await trustedSequencer.address,
        );

        // Approve tokens
        await expect(
            maticTokenContract.connect(trustedSequencer).approve(firechainZkEVMContract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        const lastBatchSequenced = await firechainZkEVMContract.lastBatchSequenced();

        // Test sequence batches errors
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([], trustedSequencer.address))
            .to.be.revertedWith('SequenceZeroBatches');

        sequence.globalExitRoot = ethers.MaxUint256;
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([sequence], trustedSequencer.address))
            .to.be.revertedWith('GlobalExitRootNotExist');
        sequence.globalExitRoot = ethers.HashZero;

        // Sequence batch
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([sequence], deployer.address))
            .to.emit(firechainZkEVMContract, 'SequenceBatches')
            .withArgs(lastBatchSequenced + 1);

        const sequencedTimestamp = (await ethers.provider.getBlock()).timestamp;

        const finalOwnerBalance = await maticTokenContract.balanceOf(
            await trustedSequencer.address,
        );
        expect(finalOwnerBalance).to.equal(
            ethers.BigNumber.from(initialOwnerBalance).sub(ethers.BigNumber.from(maticAmount)),
        );

        // Check batch mapping
        const sequencedBatchData = await firechainZkEVMContract.sequencedBatches(1);
        const batchAccInputHash = sequencedBatchData.accInputHash;

        const batchAccInputHashJs = calculateAccInputHash(
            (await firechainZkEVMContract.sequencedBatches(0)).accInputHash,
            calculateBatchHashData(sequence.transactions),
            sequence.globalExitRoot,
            sequence.timestamp,
            deployer.address,
        );
        expect(batchAccInputHash).to.be.equal(batchAccInputHashJs);
        expect(sequencedBatchData.sequencedTimestamp).to.be.equal(sequencedTimestamp);
        expect(sequencedBatchData.previousLastBatchSequenced).to.be.equal(0);
    });

    it('sequenceBatches should sequence multiple batches', async () => {
        const l2txData = '0x1234';
        const maticAmount = (await firechainZkEVMContract.batchFee()).mul(2);

        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const sequence = {
            transactions: l2txData,
            globalExitRoot: ethers.HashZero,
            timestamp: currentTimestamp,
            minForcedTimestamp: 0,
        };

        const sequence2 = {
            transactions: l2txData,
            globalExitRoot: ethers.HashZero,
            timestamp: currentTimestamp,
            minForcedTimestamp: 0,
        };

        const initialOwnerBalance = await maticTokenContract.balanceOf(
            await trustedSequencer.address,
        );

        // Approve tokens
        await expect(
            maticTokenContract.connect(trustedSequencer).approve(firechainZkEVMContract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        const lastBatchSequenced = await firechainZkEVMContract.lastBatchSequenced();

        // Sequence batches
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([sequence, sequence2], trustedSequencer.address))
            .to.emit(firechainZkEVMContract, 'SequenceBatches')
            .withArgs(lastBatchSequenced + 2);

        const finalOwnerBalance = await maticTokenContract.balanceOf(
            await trustedSequencer.address,
        );

        expect(finalOwnerBalance).to.equal(
            ethers.BigNumber.from(initialOwnerBalance).sub(ethers.BigNumber.from(maticAmount)),
        );

        // Check batch mapping
        const sequencedBatchData = await firechainZkEVMContract.sequencedBatches(1);
        const batchAccInputHash = sequencedBatchData.accInputHash;

        // Only last batch is added to the mapping
        expect(batchAccInputHash).to.be.equal(ethers.HashZero);

        const sequencedBatchData2 = await firechainZkEVMContract.sequencedBatches(2);
        const batchAccInputHash2 = sequencedBatchData2.accInputHash;

        // Calculate input Hahs for batch 1
        let batchAccInputHashJs = calculateAccInputHash(
            ethers.HashZero,
            calculateBatchHashData(sequence.transactions),
            sequence.globalExitRoot,
            sequence.timestamp,
            trustedSequencer.address,
        );

        // Calculate input Hahs for batch 2
        batchAccInputHashJs = calculateAccInputHash(
            batchAccInputHashJs,
            calculateBatchHashData(sequence2.transactions),
            sequence2.globalExitRoot,
            sequence2.timestamp,
            trustedSequencer.address,
        );
        expect(batchAccInputHash2).to.be.equal(batchAccInputHashJs);
    });

    it('force batches through smart contract', async () => {
        const l2txDataForceBatch = '0x123456';
        const maticAmount = await firechainZkEVMContract.getForcedBatchFee();
        const lastGlobalExitRoot = await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot();

        // deploy sender SC
        const sendDataFactory = await ethers.getContractFactory('SendData');
        const sendDataContract = await sendDataFactory.deploy();
        await sendDataContract.deployed();

        // transfer matic
        await maticTokenContract.transfer(sendDataContract.address, ethers.parseEther('1000'));

        // Approve matic
        const approveTx = await maticTokenContract.populateTransaction.approve(firechainZkEVMContract.address, maticAmount);
        await sendDataContract.sendData(approveTx.to, approveTx.data);

        // Activate forced batches
        await expect(
            firechainZkEVMContract.connect(admin).activateForceBatches(),
        ).to.emit(firechainZkEVMContract, 'ActivateForceBatches');

        // Force batch
        const lastForcedBatch = (await firechainZkEVMContract.lastForceBatch()) + 1;

        const forceBatchTx = await firechainZkEVMContract.populateTransaction.forceBatch(l2txDataForceBatch, maticAmount);
        await expect(sendDataContract.sendData(forceBatchTx.to, forceBatchTx.data))
            .to.emit(firechainZkEVMContract, 'ForceBatch')
            .withArgs(lastForcedBatch, lastGlobalExitRoot, sendDataContract.address, l2txDataForceBatch);
    });

    it('sequenceBatches should sequence multiple batches and force batches', async () => {
        const l2txDataForceBatch = '0x123456';
        const maticAmount = await firechainZkEVMContract.getForcedBatchFee();
        const lastGlobalExitRoot = await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot();

        await expect(
            maticTokenContract.approve(firechainZkEVMContract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        const lastForcedBatch = (await firechainZkEVMContract.lastForceBatch()) + 1;

        // Activate forced batches
        await expect(
            firechainZkEVMContract.connect(admin).activateForceBatches(),
        ).to.emit(firechainZkEVMContract, 'ActivateForceBatches');

        // Force batch
        await expect(firechainZkEVMContract.forceBatch(l2txDataForceBatch, maticAmount))
            .to.emit(firechainZkEVMContract, 'ForceBatch')
            .withArgs(lastForcedBatch, lastGlobalExitRoot, deployer.address, '0x');

        // sequence 2 batches
        const l2txData = '0x1234';
        const maticAmountSequence = (await firechainZkEVMContract.batchFee()).mul(1);

        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const sequence = {
            transactions: l2txDataForceBatch,
            globalExitRoot: lastGlobalExitRoot,
            timestamp: currentTimestamp,
            minForcedTimestamp: currentTimestamp,
        };

        const sequence2 = {
            transactions: l2txData,
            globalExitRoot: ethers.HashZero,
            timestamp: currentTimestamp,
            minForcedTimestamp: 0,
        };

        const initialOwnerBalance = await maticTokenContract.balanceOf(
            await trustedSequencer.address,
        );

        // Approve tokens
        await expect(
            maticTokenContract.connect(trustedSequencer).approve(firechainZkEVMContract.address, maticAmountSequence),
        ).to.emit(maticTokenContract, 'Approval');

        const lastBatchSequenced = await firechainZkEVMContract.lastBatchSequenced();

        // Assert that the timestamp requirements must accomplish with force batches too
        sequence.minForcedTimestamp += 1;
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([sequence, sequence2], trustedSequencer.address))
            .to.be.revertedWith('ForcedDataDoesNotMatch');
        sequence.minForcedTimestamp -= 1;

        sequence.timestamp -= 1;
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([sequence, sequence2], trustedSequencer.address))
            .to.be.revertedWith('SequencedTimestampBelowForcedTimestamp');
        sequence.timestamp += 1;

        sequence.timestamp = currentTimestamp + 10;
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([sequence, sequence2], trustedSequencer.address))
            .to.be.revertedWith('SequencedTimestampInvalid');
        sequence.timestamp = currentTimestamp;

        sequence2.timestamp -= 1;
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([sequence, sequence2], trustedSequencer.address))
            .to.be.revertedWith('SequencedTimestampInvalid');
        sequence2.timestamp += 1;

        // Sequence Bathces
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([sequence, sequence2], trustedSequencer.address))
            .to.emit(firechainZkEVMContract, 'SequenceBatches')
            .withArgs(Number(lastBatchSequenced) + 2);

        const sequencedTimestamp = (await ethers.provider.getBlock()).timestamp;

        const finalOwnerBalance = await maticTokenContract.balanceOf(
            await trustedSequencer.address,
        );

        expect(finalOwnerBalance).to.equal(
            ethers.BigNumber.from(initialOwnerBalance).sub(ethers.BigNumber.from(maticAmountSequence)),
        );

        // Check batch mapping
        const batchAccInputHash = (await firechainZkEVMContract.sequencedBatches(1)).accInputHash;
        // Only last batch is added to the mapping
        expect(batchAccInputHash).to.be.equal(ethers.HashZero);

        /*
         * Check batch mapping
         * Calculate input Hahs for batch 1
         */
        let batchAccInputHashJs = calculateAccInputHash(
            ethers.HashZero,
            calculateBatchHashData(sequence.transactions),
            sequence.globalExitRoot,
            sequence.timestamp,
            trustedSequencer.address,
        );

        // Calculate input Hahs for batch 2
        batchAccInputHashJs = calculateAccInputHash(
            batchAccInputHashJs,
            calculateBatchHashData(sequence2.transactions),
            sequence2.globalExitRoot,
            sequence2.timestamp,
            trustedSequencer.address,
        );
        const batchData2 = await firechainZkEVMContract.sequencedBatches(2);
        expect(batchData2.accInputHash).to.be.equal(batchAccInputHashJs);
        expect(batchData2.sequencedTimestamp).to.be.equal(sequencedTimestamp);
        expect(batchData2.previousLastBatchSequenced).to.be.equal(0);
    });

    it('sequenceBatches should check the timestamp correctly', async () => {
        const l2txData = '0x';
        const maticAmount = (await firechainZkEVMContract.batchFee()).mul(2);

        const sequence = {
            transactions: l2txData,
            globalExitRoot: ethers.HashZero,
            timestamp: 0,
            minForcedTimestamp: 0,
        };

        const sequence2 = {
            transactions: l2txData,
            globalExitRoot: ethers.HashZero,
            timestamp: 0,
            minForcedTimestamp: 0,
        };

        const initialOwnerBalance = await maticTokenContract.balanceOf(
            await trustedSequencer.address,
        );

        // Approve tokens
        await expect(
            maticTokenContract.connect(trustedSequencer).approve(firechainZkEVMContract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        const lastBatchSequenced = await firechainZkEVMContract.lastBatchSequenced();

        let currentTimestamp = (await ethers.provider.getBlock()).timestamp;
        await ethers.provider.send('evm_increaseTime', [1]); // evm_setNextBlockTimestamp

        sequence.timestamp = currentTimestamp + 2; // bigger than current block timestamp

        // revert because timestamp is more than the current one
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([sequence], trustedSequencer.address))
            .to.be.revertedWith('SequencedTimestampInvalid');

        currentTimestamp = (await ethers.provider.getBlock()).timestamp;
        await ethers.provider.send('evm_increaseTime', [1]);

        sequence.timestamp = currentTimestamp;
        sequence2.timestamp = currentTimestamp - 1;

        // revert because the second sequence has less timestamp than the previous batch
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([sequence, sequence2], trustedSequencer.address))
            .to.be.revertedWith('SequencedTimestampInvalid');

        currentTimestamp = (await ethers.provider.getBlock()).timestamp;
        await ethers.provider.send('evm_increaseTime', [1]);

        sequence.timestamp = currentTimestamp + 1; // edge case, same timestamp as the block
        sequence2.timestamp = currentTimestamp + 1;

        // Sequence Batches
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([sequence, sequence2], trustedSequencer.address))
            .to.emit(firechainZkEVMContract, 'SequenceBatches')
            .withArgs(lastBatchSequenced + 2);

        const finalOwnerBalance = await maticTokenContract.balanceOf(
            await trustedSequencer.address,
        );
        expect(finalOwnerBalance).to.equal(
            ethers.BigNumber.from(initialOwnerBalance).sub(ethers.BigNumber.from(maticAmount)),
        );
    });

    it('should force a batch of transactions', async () => {
        const l2txData = '0x123456';
        const maticAmount = await firechainZkEVMContract.getForcedBatchFee();
        const lastGlobalExitRoot = await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot();

        expect(maticAmount.toString()).to.be.equal((await firechainZkEVMContract.getForcedBatchFee()).toString());

        // Activate force batches
        await expect(
            firechainZkEVMContract.connect(admin).activateForceBatches(),
        ).to.emit(firechainZkEVMContract, 'ActivateForceBatches');

        // revert because the maxMatic amount is less than the necessary to pay
        await expect(firechainZkEVMContract.forceBatch(l2txData, maticAmount.sub(1)))
            .to.be.revertedWith('NotEnoughMaticAmount');

        // revert because tokens were not approved
        await expect(firechainZkEVMContract.forceBatch(l2txData, maticAmount))
            .to.be.revertedWith('ERC20: insufficient allowance');

        const initialOwnerBalance = await maticTokenContract.balanceOf(
            await deployer.address,
        );
        await expect(
            maticTokenContract.approve(firechainZkEVMContract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        const lastForceBatch = await firechainZkEVMContract.lastForceBatch();

        // Force batch
        await expect(firechainZkEVMContract.forceBatch(l2txData, maticAmount))
            .to.emit(firechainZkEVMContract, 'ForceBatch')
            .withArgs(lastForceBatch + 1, lastGlobalExitRoot, deployer.address, '0x');

        const finalOwnerBalance = await maticTokenContract.balanceOf(
            await deployer.address,
        );
        expect(finalOwnerBalance).to.equal(
            ethers.BigNumber.from(initialOwnerBalance).sub(ethers.BigNumber.from(maticAmount)),
        );

        // Check force batches struct
        const batchHash = await firechainZkEVMContract.forcedBatches(1);
        const timestampForceBatch = (await ethers.provider.getBlock()).timestamp;

        const batchHashJs = ethers.solidityPackedKeccak256(
            ['bytes32', 'bytes32', 'uint64'],
            [
                calculateBatchHashData(l2txData),
                lastGlobalExitRoot,
                timestampForceBatch,
            ],
        );
        expect(batchHashJs).to.be.equal(batchHash);
    });

    it('should sequence force batches using sequenceForceBatches', async () => {
        const l2txData = '0x123456';
        const maticAmount = await firechainZkEVMContract.getForcedBatchFee();
        const lastGlobalExitRoot = await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot();

        await expect(
            maticTokenContract.approve(firechainZkEVMContract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        // Activate force batches
        await expect(
            firechainZkEVMContract.connect(admin).activateForceBatches(),
        ).to.emit(firechainZkEVMContract, 'ActivateForceBatches');

        const lastForcedBatch = (await firechainZkEVMContract.lastForceBatch()) + 1;

        await expect(firechainZkEVMContract.forceBatch(l2txData, maticAmount))
            .to.emit(firechainZkEVMContract, 'ForceBatch')
            .withArgs(lastForcedBatch, lastGlobalExitRoot, deployer.address, '0x');

        const timestampForceBatch = (await ethers.provider.getBlock()).timestamp;

        const forceBatchHash = await firechainZkEVMContract.forcedBatches(1);

        const batchHashJs = ethers.solidityPackedKeccak256(
            ['bytes32', 'bytes32', 'uint64'],
            [
                calculateBatchHashData(l2txData),
                lastGlobalExitRoot,
                timestampForceBatch,
            ],
        );
        expect(batchHashJs).to.be.equal(forceBatchHash);

        // Check storage variables before call
        expect(await firechainZkEVMContract.lastForceBatchSequenced()).to.be.equal(0);
        expect(await firechainZkEVMContract.lastForceBatch()).to.be.equal(1);
        expect(await firechainZkEVMContract.lastBatchSequenced()).to.be.equal(0);

        const forceBatchStruct = {
            transactions: l2txData,
            globalExitRoot: lastGlobalExitRoot,
            minForcedTimestamp: timestampForceBatch,
        };

        // revert because the timeout is not expired
        await expect(firechainZkEVMContract.sequenceForceBatches([]))
            .to.be.revertedWith('SequenceZeroBatches');

        // revert because does not exist that many forced Batches
        await expect(firechainZkEVMContract.sequenceForceBatches(Array(2).fill(forceBatchStruct)))
            .to.be.revertedWith('ForceBatchesOverflow');

        // revert because the timeout is not expired
        await expect(firechainZkEVMContract.sequenceForceBatches([forceBatchStruct]))
            .to.be.revertedWith('ForceBatchTimeoutNotExpired');

        const forceBatchStructBad = {
            transactions: l2txData,
            globalExitRoot: lastGlobalExitRoot,
            minForcedTimestamp: timestampForceBatch,
        };

        forceBatchStructBad.minForcedTimestamp += 1;
        await expect(firechainZkEVMContract.sequenceForceBatches([forceBatchStructBad]))
            .to.be.revertedWith('ForcedDataDoesNotMatch');
        forceBatchStructBad.minForcedTimestamp -= 1;

        forceBatchStructBad.globalExitRoot = ethers.HashZero;
        await expect(firechainZkEVMContract.sequenceForceBatches([forceBatchStructBad]))
            .to.be.revertedWith('ForcedDataDoesNotMatch');
        forceBatchStructBad.globalExitRoot = lastGlobalExitRoot;

        forceBatchStructBad.transactions = '0x1111';
        await expect(firechainZkEVMContract.sequenceForceBatches([forceBatchStructBad]))
            .to.be.revertedWith('ForcedDataDoesNotMatch');
        forceBatchStructBad.transactions = l2txData;

        // Increment timestamp
        await ethers.provider.send('evm_setNextBlockTimestamp', [timestampForceBatch + FORCE_BATCH_TIMEOUT]);

        // sequence force batch
        await expect(firechainZkEVMContract.sequenceForceBatches([forceBatchStruct]))
            .to.emit(firechainZkEVMContract, 'SequenceForceBatches')
            .withArgs(1);

        const timestampSequenceBatch = (await ethers.provider.getBlock()).timestamp;

        expect(await firechainZkEVMContract.lastForceBatchSequenced()).to.be.equal(1);
        expect(await firechainZkEVMContract.lastForceBatch()).to.be.equal(1);
        expect(await firechainZkEVMContract.lastBatchSequenced()).to.be.equal(1);

        // Check force batches struct
        const batchAccInputHash = (await firechainZkEVMContract.sequencedBatches(1)).accInputHash;

        const batchAccInputHashJs = calculateAccInputHash(
            ethers.HashZero,
            calculateBatchHashData(l2txData),
            lastGlobalExitRoot,
            timestampSequenceBatch,
            deployer.address,
        );
        expect(batchAccInputHash).to.be.equal(batchAccInputHashJs);
    });

    it('should verify a sequenced batch using verifyBatchesTrustedAggregator', async () => {
        const l2txData = '0x123456';
        const maticAmount = await firechainZkEVMContract.batchFee();
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const sequence = {
            transactions: l2txData,
            globalExitRoot: ethers.HashZero,
            timestamp: currentTimestamp,
            minForcedTimestamp: 0,
        };

        // Approve tokens
        await expect(
            maticTokenContract.connect(trustedSequencer).approve(firechainZkEVMContract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        const lastBatchSequenced = await firechainZkEVMContract.lastBatchSequenced();
        // Sequence Batches
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([sequence], trustedSequencer.address))
            .to.emit(firechainZkEVMContract, 'SequenceBatches')
            .withArgs(lastBatchSequenced + 1);

        // trustedAggregator forge the batch
        const pendingState = 0;
        const newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000000';
        const newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000000000';
        const numBatch = (await firechainZkEVMContract.lastVerifiedBatch()) + 1;
        const zkProofFFlonk = new Array(24).fill(ethers.HashZero);

        const initialAggregatorMatic = await maticTokenContract.balanceOf(
            trustedAggregator.address,
        );

        await expect(
            firechainZkEVMContract.connect(deployer).verifyBatchesTrustedAggregator(
                pendingState,
                numBatch - 1,
                numBatch - 1,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('OnlyTrustedAggregator');

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                pendingState,
                numBatch - 1,
                numBatch - 1,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('FinalNumBatchBelowLastVerifiedBatch');

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                pendingState,
                numBatch - 1,
                numBatch + 1,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('NewAccInputHashDoesNotExist');

        // Verify batch
        await expect(
            firechainZkEVMContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                pendingState,
                numBatch - 1,
                numBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(firechainZkEVMContract, 'VerifyBatchesTrustedAggregator')
            .withArgs(numBatch, newStateRoot, trustedAggregator.address);

        const finalAggregatorMatic = await maticTokenContract.balanceOf(
            trustedAggregator.address,
        );
        expect(finalAggregatorMatic).to.equal(
            ethers.BigNumber.from(initialAggregatorMatic).add(ethers.BigNumber.from(maticAmount)),
        );
    });

    it('should verify forced sequenced batch using verifyBatchesTrustedAggregator', async () => {
        const l2txData = '0x123456';
        const maticAmount = await firechainZkEVMContract.getForcedBatchFee();
        const lastGlobalExitRoot = await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot();

        await expect(
            maticTokenContract.approve(firechainZkEVMContract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        // Activate force batches
        await expect(
            firechainZkEVMContract.connect(admin).activateForceBatches(),
        ).to.emit(firechainZkEVMContract, 'ActivateForceBatches');

        const lastForcedBatch = (await firechainZkEVMContract.lastForceBatch()) + 1;
        await expect(firechainZkEVMContract.forceBatch(l2txData, maticAmount))
            .to.emit(firechainZkEVMContract, 'ForceBatch')
            .withArgs(lastForcedBatch, lastGlobalExitRoot, deployer.address, '0x');

        const timestampForceBatch = (await ethers.provider.getBlock()).timestamp;
        // Increment timestamp
        await ethers.provider.send('evm_setNextBlockTimestamp', [timestampForceBatch + FORCE_BATCH_TIMEOUT]);

        const forceBatchStruct = {
            transactions: l2txData,
            globalExitRoot: lastGlobalExitRoot,
            minForcedTimestamp: timestampForceBatch,
        };

        // sequence force batch
        await expect(firechainZkEVMContract.sequenceForceBatches([forceBatchStruct]))
            .to.emit(firechainZkEVMContract, 'SequenceForceBatches')
            .withArgs(lastForcedBatch);

        // trustedAggregator forge the batch
        const pendingState = 0;
        const newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000000';
        const newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000000000';
        const numBatch = (await firechainZkEVMContract.lastVerifiedBatch()) + 1;
        const zkProofFFlonk = new Array(24).fill(ethers.HashZero);

        const initialAggregatorMatic = await maticTokenContract.balanceOf(
            trustedAggregator.address,
        );

        // Verify batch
        await expect(
            firechainZkEVMContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                pendingState,
                numBatch - 1,
                numBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(firechainZkEVMContract, 'VerifyBatch')
            .withArgs(numBatch, trustedAggregator.address)
            .to.emit(maticTokenContract, 'Transfer')
            .withArgs(firechainZkEVMContract.address, trustedAggregator.address, maticAmount);

        const finalAggregatorMatic = await maticTokenContract.balanceOf(
            trustedAggregator.address,
        );

        expect(finalAggregatorMatic).to.equal(
            ethers.BigNumber.from(initialAggregatorMatic).add(ethers.BigNumber.from(maticAmount)),
        );
    });

    it('should match the computed SC input with the Js input', async () => {
        const l2txData = '0x123456';
        const maticAmount = await firechainZkEVMContract.batchFee();
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const sequence = {
            transactions: l2txData,
            globalExitRoot: ethers.HashZero,
            timestamp: currentTimestamp,
            minForcedTimestamp: 0,
        };

        // Approve tokens
        await expect(
            maticTokenContract.connect(trustedSequencer).approve(firechainZkEVMContract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        const lastBatchSequenced = await firechainZkEVMContract.lastBatchSequenced();

        // Sequence
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([sequence], trustedSequencer.address))
            .to.emit(firechainZkEVMContract, 'SequenceBatches')
            .withArgs(lastBatchSequenced + 1);

        const sentBatchHash = (await firechainZkEVMContract.sequencedBatches(lastBatchSequenced + 1)).accInputHash;
        const oldAccInputHash = (await firechainZkEVMContract.sequencedBatches(0)).accInputHash;

        const batchAccInputHashJs = calculateAccInputHash(
            oldAccInputHash,
            calculateBatchHashData(sequence.transactions),
            sequence.globalExitRoot,
            sequence.timestamp,
            trustedSequencer.address,
        );
        expect(sentBatchHash).to.be.equal(batchAccInputHashJs);

        // Compute circuit input with the SC function
        const currentStateRoot = await firechainZkEVMContract.batchNumToStateRoot(0);
        const newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000001234';
        const newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000456';
        const numBatch = (await firechainZkEVMContract.lastVerifiedBatch()) + 1;

        // Compute Js input
        const inputSnarkJS = await calculateSnarkInput(
            currentStateRoot,
            newStateRoot,
            newLocalExitRoot,
            oldAccInputHash,
            batchAccInputHashJs,
            numBatch - 1,
            numBatch,
            chainID,
            deployer.address,
            forkID,
        );

        // Compute Js input
        const pendingStateNum = 0;
        const circuitInpuSnarkSC = await firechainZkEVMContract.getNextSnarkInput(
            pendingStateNum,
            numBatch - 1,
            numBatch,
            newLocalExitRoot,
            newStateRoot,
        );

        expect(circuitInpuSnarkSC).to.be.equal(inputSnarkJS);
    });

    it('should match the computed SC input with the Js input in force batches', async () => {
        const l2txData = '0x123456';
        const maticAmount = await firechainZkEVMContract.getForcedBatchFee();
        const lastGlobalExitRoot = await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot();

        await expect(
            maticTokenContract.approve(firechainZkEVMContract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        // Activate force batches
        await expect(
            firechainZkEVMContract.connect(admin).activateForceBatches(),
        ).to.emit(firechainZkEVMContract, 'ActivateForceBatches');

        const lastForcedBatch = (await firechainZkEVMContract.lastForceBatch()).toNumber() + 1;
        await expect(firechainZkEVMContract.forceBatch(l2txData, maticAmount))
            .to.emit(firechainZkEVMContract, 'ForceBatch')
            .withArgs(lastForcedBatch, lastGlobalExitRoot, deployer.address, '0x');

        const timestampForceBatch = (await ethers.provider.getBlock()).timestamp;

        // Increment timestamp
        await ethers.provider.send('evm_setNextBlockTimestamp', [timestampForceBatch + FORCE_BATCH_TIMEOUT]);

        const forceBatchStruct = {
            transactions: l2txData,
            globalExitRoot: lastGlobalExitRoot,
            minForcedTimestamp: timestampForceBatch,
        };

        // sequence force batch
        await expect(firechainZkEVMContract.sequenceForceBatches([forceBatchStruct]))
            .to.emit(firechainZkEVMContract, 'SequenceForceBatches')
            .withArgs(lastForcedBatch);

        const sequencedTimestmap = (await ethers.provider.getBlock()).timestamp;
        const oldAccInputHash = (await firechainZkEVMContract.sequencedBatches(0)).accInputHash;
        const batchAccInputHash = (await firechainZkEVMContract.sequencedBatches(1)).accInputHash;

        const batchAccInputHashJs = calculateAccInputHash(
            oldAccInputHash,
            calculateBatchHashData(l2txData),
            lastGlobalExitRoot,
            sequencedTimestmap,
            deployer.address,
        );
        expect(batchAccInputHash).to.be.equal(batchAccInputHashJs);

        // Compute circuit input with the SC function
        const currentStateRoot = await firechainZkEVMContract.batchNumToStateRoot(0);
        const newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000001234';
        const newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000456';
        const numBatch = (await firechainZkEVMContract.lastVerifiedBatch()) + 1;

        // Compute Js input
        const inputSnarkJS = await calculateSnarkInput(
            currentStateRoot,
            newStateRoot,
            newLocalExitRoot,
            oldAccInputHash,
            batchAccInputHashJs,
            numBatch - 1,
            numBatch,
            chainID,
            deployer.address,
            forkID,
        );

        // Compute Js input
        const pendingStateNum = 0;
        const circuitInpuSnarkSC = await firechainZkEVMContract.getNextSnarkInput(
            pendingStateNum,
            numBatch - 1,
            numBatch,
            newLocalExitRoot,
            newStateRoot,
        );

        expect(circuitInpuSnarkSC).to.be.equal(inputSnarkJS);
    });

    it('should verify a sequenced batch using verifyBatches', async () => {
        const l2txData = '0x123456';
        const maticAmount = await firechainZkEVMContract.batchFee();
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const sequence = {
            transactions: l2txData,
            globalExitRoot: ethers.HashZero,
            timestamp: currentTimestamp,
            minForcedTimestamp: 0,
        };

        // Approve tokens
        await expect(
            maticTokenContract.connect(trustedSequencer).approve(firechainZkEVMContract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        const lastBatchSequenced = await firechainZkEVMContract.lastBatchSequenced();
        // Sequence Batches
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([sequence], trustedSequencer.address))
            .to.emit(firechainZkEVMContract, 'SequenceBatches')
            .withArgs(lastBatchSequenced + 1);

        // aggregator forge the batch
        const pendingState = 0;
        const newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';
        const newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000000002';
        const numBatch = (await firechainZkEVMContract.lastVerifiedBatch()) + 1;
        const zkProofFFlonk = new Array(24).fill(ethers.HashZero);

        const initialAggregatorMatic = await maticTokenContract.balanceOf(
            aggregator1.address,
        );

        const sequencedBatchData = await firechainZkEVMContract.sequencedBatches(1);
        const { sequencedTimestamp } = sequencedBatchData;
        const currentBatchFee = await firechainZkEVMContract.batchFee();

        await expect(
            firechainZkEVMContract.connect(aggregator1).verifyBatches(
                pendingState,
                numBatch - 1,
                numBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('TrustedAggregatorTimeoutNotExpired');

        await ethers.provider.send('evm_setNextBlockTimestamp', [sequencedTimestamp.toNumber() + trustedAggregatorTimeoutDefault - 1]);

        await expect(
            firechainZkEVMContract.connect(aggregator1).verifyBatches(
                pendingState,
                numBatch - 1,
                numBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('TrustedAggregatorTimeoutNotExpired');

        await expect(
            firechainZkEVMContract.connect(aggregator1).verifyBatches(
                pendingState,
                numBatch - 1,
                numBatch + 1,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('NewAccInputHashDoesNotExist');

        await expect(
            firechainZkEVMContract.connect(aggregator1).verifyBatches(
                pendingState,
                numBatch - 1,
                numBatch + _MAX_VERIFY_BATCHES,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('ExceedMaxVerifyBatches');
        // Verify batch
        await expect(
            firechainZkEVMContract.connect(aggregator1).verifyBatches(
                pendingState,
                numBatch - 1,
                numBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(firechainZkEVMContract, 'VerifyBatches')
            .withArgs(numBatch, newStateRoot, aggregator1.address);

        const verifyTimestamp = (await ethers.provider.getBlock()).timestamp;

        const finalAggregatorMatic = await maticTokenContract.balanceOf(
            aggregator1.address,
        );
        expect(finalAggregatorMatic).to.equal(
            ethers.BigNumber.from(initialAggregatorMatic).add(ethers.BigNumber.from(maticAmount)),
        );

        // Check pending state
        const lastPendingstate = 1;
        expect(lastPendingstate).to.be.equal(await firechainZkEVMContract.lastPendingState());

        const pendingStateData = await firechainZkEVMContract.pendingStateTransitions(lastPendingstate);
        expect(verifyTimestamp).to.be.equal(pendingStateData.timestamp);
        expect(numBatch).to.be.equal(pendingStateData.lastVerifiedBatch);
        expect(newLocalExitRoot).to.be.equal(pendingStateData.exitRoot);
        expect(newStateRoot).to.be.equal(pendingStateData.stateRoot);

        // Try consolidate state
        expect(0).to.be.equal(await firechainZkEVMContract.lastVerifiedBatch());

        // Pending state can't be 0
        await expect(
            firechainZkEVMContract.consolidatePendingState(0),
        ).to.be.revertedWith('PendingStateInvalid');

        // Pending state does not exist
        await expect(
            firechainZkEVMContract.consolidatePendingState(2),
        ).to.be.revertedWith('PendingStateInvalid');

        // Not ready to be consolidated
        await expect(
            firechainZkEVMContract.consolidatePendingState(lastPendingstate),
        ).to.be.revertedWith('PendingStateNotConsolidable');

        await ethers.provider.send('evm_setNextBlockTimestamp', [verifyTimestamp + pendingStateTimeoutDefault - 1]);

        await expect(
            firechainZkEVMContract.consolidatePendingState(lastPendingstate),
        ).to.be.revertedWith('PendingStateNotConsolidable');

        await expect(
            firechainZkEVMContract.consolidatePendingState(lastPendingstate),
        ).to.emit(firechainZkEVMContract, 'ConsolidatePendingState')
            .withArgs(numBatch, newStateRoot, lastPendingstate);

        // Pending state already consolidated
        await expect(
            firechainZkEVMContract.consolidatePendingState(1),
        ).to.be.revertedWith('PendingStateInvalid');

        // Fee es divided because is was fast verified
        const multiplierFee = await firechainZkEVMContract.multiplierBatchFee();
        expect((currentBatchFee.mul(1000)).div(multiplierFee)).to.be.equal(await firechainZkEVMContract.batchFee());

        // Check pending state variables
        expect(1).to.be.equal(await firechainZkEVMContract.lastVerifiedBatch());
        expect(newStateRoot).to.be.equal(await firechainZkEVMContract.batchNumToStateRoot(1));
        expect(1).to.be.equal(await firechainZkEVMContract.lastPendingStateConsolidated());
    });

    it('should test the pending state properly', async () => {
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

        // Verify batch
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

        let verifyTimestamp = (await ethers.provider.getBlock()).timestamp;

        // Check pending state
        currentPendingState++;
        expect(currentPendingState).to.be.equal(await firechainZkEVMContract.lastPendingState());

        let currentPendingStateData = await firechainZkEVMContract.pendingStateTransitions(currentPendingState);
        expect(verifyTimestamp).to.be.equal(currentPendingStateData.timestamp);
        expect(newBatch).to.be.equal(currentPendingStateData.lastVerifiedBatch);
        expect(newLocalExitRoot).to.be.equal(currentPendingStateData.exitRoot);
        expect(newStateRoot).to.be.equal(currentPendingStateData.stateRoot);

        // Try to verify Batches that does not go beyond the last pending state
        await expect(
            firechainZkEVMContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                0,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('FinalNumBatchBelowLastVerifiedBatch');

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                10,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('PendingStateDoesNotExist');

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('InitNumBatchDoesNotMatchPendingState');

        currentNumBatch = newBatch;
        newBatch += batchesForSequence;

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(firechainZkEVMContract, 'VerifyBatchesTrustedAggregator')
            .withArgs(newBatch, newStateRoot, trustedAggregator.address);

        // Check pending state is clear
        currentPendingState = 0;
        expect(currentPendingState).to.be.equal(await firechainZkEVMContract.lastPendingState());
        expect(0).to.be.equal(await firechainZkEVMContract.lastPendingStateConsolidated());

        // Check consolidated state
        let currentVerifiedBatch = newBatch;
        expect(currentVerifiedBatch).to.be.equal(await firechainZkEVMContract.lastVerifiedBatch());
        expect(newStateRoot).to.be.equal(await firechainZkEVMContract.batchNumToStateRoot(currentVerifiedBatch));

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                1,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('PendingStateDoesNotExist');

        // Since this pending state was not consolidated, the currentNumBatch does not have stored root
        expect(ethers.HashZero).to.be.equal(await firechainZkEVMContract.batchNumToStateRoot(currentNumBatch));
        await expect(
            firechainZkEVMContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                currentPendingState,
                currentNumBatch,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('OldStateRootDoesNotExist');

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                currentPendingState,
                0,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('FinalNumBatchBelowLastVerifiedBatch');

        // Again use verifyBatches
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

        // Check pending state
        verifyTimestamp = (await ethers.provider.getBlock()).timestamp;
        currentPendingState++;
        expect(currentPendingState).to.be.equal(await firechainZkEVMContract.lastPendingState());

        currentPendingStateData = await firechainZkEVMContract.pendingStateTransitions(currentPendingState);
        expect(verifyTimestamp).to.be.equal(currentPendingStateData.timestamp);
        expect(newBatch).to.be.equal(currentPendingStateData.lastVerifiedBatch);
        expect(newLocalExitRoot).to.be.equal(currentPendingStateData.exitRoot);
        expect(newStateRoot).to.be.equal(currentPendingStateData.stateRoot);

        // Verify another sequence from batch 0
        currentNumBatch = newBatch;
        newBatch += batchesForSequence;

        await expect(
            firechainZkEVMContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                0,
                1,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('OldStateRootDoesNotExist');

        await expect(
            firechainZkEVMContract.connect(aggregator1).verifyBatches(
                0,
                0,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(firechainZkEVMContract, 'VerifyBatches')
            .withArgs(newBatch, newStateRoot, aggregator1.address);

        // Check pending state
        verifyTimestamp = (await ethers.provider.getBlock()).timestamp;
        currentPendingState++;
        expect(currentPendingState).to.be.equal(await firechainZkEVMContract.lastPendingState());

        currentPendingStateData = await firechainZkEVMContract.pendingStateTransitions(currentPendingState);
        expect(verifyTimestamp).to.be.equal(currentPendingStateData.timestamp);
        expect(newBatch).to.be.equal(currentPendingStateData.lastVerifiedBatch);
        expect(newLocalExitRoot).to.be.equal(currentPendingStateData.exitRoot);
        expect(newStateRoot).to.be.equal(currentPendingStateData.stateRoot);

        // Verify batches using old pending state
        currentNumBatch = newBatch;
        newBatch += batchesForSequence;

        // Must specify pending state num while is not consolidated
        await expect(
            firechainZkEVMContract.connect(trustedAggregator).verifyBatchesTrustedAggregator(
                0,
                currentNumBatch - 5,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('OldStateRootDoesNotExist');

        await expect(
            firechainZkEVMContract.connect(aggregator1).verifyBatches(
                currentPendingState - 1,
                currentNumBatch - 5,
                newBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(firechainZkEVMContract, 'VerifyBatches')
            .withArgs(newBatch, newStateRoot, aggregator1.address);

        verifyTimestamp = (await ethers.provider.getBlock()).timestamp;
        currentPendingState++;
        expect(currentPendingState).to.be.equal(await firechainZkEVMContract.lastPendingState());

        currentPendingStateData = await firechainZkEVMContract.pendingStateTransitions(currentPendingState);
        expect(verifyTimestamp).to.be.equal(currentPendingStateData.timestamp);
        expect(newBatch).to.be.equal(currentPendingStateData.lastVerifiedBatch);
        expect(newLocalExitRoot).to.be.equal(currentPendingStateData.exitRoot);
        expect(newStateRoot).to.be.equal(currentPendingStateData.stateRoot);

        // Consolidate using verifyBatches
        const firstPendingState = await firechainZkEVMContract.pendingStateTransitions(1);
        await ethers.provider.send('evm_setNextBlockTimestamp', [firstPendingState.timestamp.toNumber() + pendingStateTimeoutDefault]);

        let currentPendingConsolidated = 0;
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
            .withArgs(newBatch, newStateRoot, aggregator1.address)
            .to.emit(firechainZkEVMContract, 'ConsolidatePendingState')
            .withArgs(firstPendingState.lastVerifiedBatch, newStateRoot, ++currentPendingConsolidated);

        verifyTimestamp = (await ethers.provider.getBlock()).timestamp;
        currentPendingState++;
        expect(currentPendingState).to.be.equal(await firechainZkEVMContract.lastPendingState());
        expect(currentPendingConsolidated).to.be.equal(await firechainZkEVMContract.lastPendingStateConsolidated());

        currentPendingStateData = await firechainZkEVMContract.pendingStateTransitions(currentPendingState);
        expect(verifyTimestamp).to.be.equal(currentPendingStateData.timestamp);
        expect(newBatch).to.be.equal(currentPendingStateData.lastVerifiedBatch);
        expect(newLocalExitRoot).to.be.equal(currentPendingStateData.exitRoot);
        expect(newStateRoot).to.be.equal(currentPendingStateData.stateRoot);

        // Check state consolidated
        currentVerifiedBatch += batchesForSequence;
        expect(currentVerifiedBatch).to.be.equal(await firechainZkEVMContract.lastVerifiedBatch());
        expect(newStateRoot).to.be.equal(await firechainZkEVMContract.batchNumToStateRoot(currentVerifiedBatch));

        // Consolidate using sendBatches
        const secondPendingState = await firechainZkEVMContract.pendingStateTransitions(2);
        await ethers.provider.send('evm_setNextBlockTimestamp', [secondPendingState.timestamp.toNumber() + pendingStateTimeoutDefault]);

        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches(sequencesArray, trustedSequencer.address))
            .to.emit(firechainZkEVMContract, 'SequenceBatches')
            .to.emit(firechainZkEVMContract, 'ConsolidatePendingState')
            .withArgs(secondPendingState.lastVerifiedBatch, newStateRoot, ++currentPendingConsolidated);

        expect(currentPendingState).to.be.equal(await firechainZkEVMContract.lastPendingState());
        expect(currentPendingConsolidated).to.be.equal(await firechainZkEVMContract.lastPendingStateConsolidated());

        // Check state consolidated
        currentVerifiedBatch += batchesForSequence;
        expect(currentVerifiedBatch).to.be.equal(await firechainZkEVMContract.lastVerifiedBatch());
        expect(newStateRoot).to.be.equal(await firechainZkEVMContract.batchNumToStateRoot(currentVerifiedBatch));

        // Put a lot of pending states and check that half of them are consoldiated
        for (let i = 0; i < 8; i++) {
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

            currentPendingState++;
        }

        expect(currentPendingState).to.be.equal(await firechainZkEVMContract.lastPendingState());

        currentPendingConsolidated = await firechainZkEVMContract.lastPendingStateConsolidated();
        const lastPendingState = await firechainZkEVMContract.pendingStateTransitions(currentPendingState);
        await ethers.provider.send('evm_setNextBlockTimestamp', [lastPendingState.timestamp.toNumber() + pendingStateTimeoutDefault]);

        // call verify batches and check that half of them are consolidated
        expect(currentPendingState).to.be.equal(await firechainZkEVMContract.lastPendingState());
        expect(currentPendingConsolidated).to.be.equal(await firechainZkEVMContract.lastPendingStateConsolidated());

        const nextPendingConsolidated = Number(currentPendingConsolidated) + 1;
        const nextConsolidatedStateNum = nextPendingConsolidated + Number(Math.floor((currentPendingState - nextPendingConsolidated) / 2));
        const nextConsolidatedState = await firechainZkEVMContract.pendingStateTransitions(nextConsolidatedStateNum);

        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches(sequencesArray, trustedSequencer.address))
            .to.emit(firechainZkEVMContract, 'SequenceBatches')
            .to.emit(firechainZkEVMContract, 'ConsolidatePendingState')
            .withArgs(nextConsolidatedState.lastVerifiedBatch, newStateRoot, nextConsolidatedStateNum);

        // Put pendingState to 0 and check that the pending state is clear after verifyBatches
        await expect(
            firechainZkEVMContract.connect(admin).setPendingStateTimeout(0),
        ).to.emit(firechainZkEVMContract, 'SetPendingStateTimeout').withArgs(0);

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

        currentPendingState = 0;
        expect(currentPendingState).to.be.equal(await firechainZkEVMContract.lastPendingState());
        expect(0).to.be.equal(await firechainZkEVMContract.lastPendingStateConsolidated());

        // Check consolidated state
        currentVerifiedBatch = newBatch;
        expect(currentVerifiedBatch).to.be.equal(await firechainZkEVMContract.lastVerifiedBatch());
        expect(newStateRoot).to.be.equal(await firechainZkEVMContract.batchNumToStateRoot(currentVerifiedBatch));
    });

    it('Activate emergency state due halt timeout', async () => {
        const l2txData = '0x123456';
        const maticAmount = await firechainZkEVMContract.batchFee();
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const sequence = {
            transactions: l2txData,
            globalExitRoot: ethers.HashZero,
            timestamp: ethers.BigNumber.from(currentTimestamp),
            minForcedTimestamp: 0,
        };

        // Approve tokens
        await expect(
            maticTokenContract.connect(trustedSequencer).approve(firechainZkEVMContract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        // Sequence batch
        const lastBatchSequenced = 1;
        await expect(firechainZkEVMContract.connect(trustedSequencer).sequenceBatches([sequence], trustedSequencer.address))
            .to.emit(firechainZkEVMContract, 'SequenceBatches')
            .withArgs(lastBatchSequenced);

        const sequencedTimestmap = Number((await firechainZkEVMContract.sequencedBatches(1)).sequencedTimestamp);
        const haltTimeout = HALT_AGGREGATION_TIMEOUT;

        // Try to activate the emergency state

        // Check batch is not sequenced
        await expect(firechainZkEVMContract.connect(aggregator1).activateEmergencyState(2))
            .to.be.revertedWith('BatchNotSequencedOrNotSequenceEnd');

        // Check batch is already verified
        await firechainZkEVMContract.setVerifiedBatch(1);
        await expect(firechainZkEVMContract.connect(aggregator1).activateEmergencyState(1))
            .to.be.revertedWith('BatchAlreadyVerified');
        await firechainZkEVMContract.setVerifiedBatch(0);

        // check timeout is not expired
        await expect(firechainZkEVMContract.connect(aggregator1).activateEmergencyState(1))
            .to.be.revertedWith('HaltTimeoutNotExpired');

        await ethers.provider.send('evm_setNextBlockTimestamp', [sequencedTimestmap + haltTimeout]);

        // Successfully activate emergency state
        await expect(firechainZkEVMContract.connect(aggregator1).activateEmergencyState(1))
            .to.emit(firechainZkEVMContract, 'EmergencyStateActivated');
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

    it('Test batch fees properly', async () => {
        const accInputData = ethers.HashZero;
        const verifyBatchTimeTarget = Number(await firechainZkEVMContract.verifyBatchTimeTarget());
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const multiplierFee = ethers.BigNumber.from(await firechainZkEVMContract.multiplierBatchFee()); // 1002
        const bingNumber1000 = ethers.BigNumber.from(1000);

        // Create sequenced to update the fee
        await firechainZkEVMContract.setSequencedBatches(
            50,
            accInputData,
            currentTimestamp + verifyBatchTimeTarget,
            0,
        ); // Edge case, will be below

        await firechainZkEVMContract.setSequencedBatches(
            100,
            accInputData,
            currentTimestamp + verifyBatchTimeTarget + 1,
            50,
        ); // Edge case, will be above

        // Assert currentFee
        let currentBatchFee = await firechainZkEVMContract.batchFee();
        expect(currentBatchFee).to.be.equal(ethers.parseEther('0.1'));

        await ethers.provider.send('evm_setNextBlockTimestamp', [currentTimestamp + verifyBatchTimeTarget * 2]);

        await firechainZkEVMContract.updateBatchFee(100);

        // Fee does not change since there are the same batches above than below
        expect(await firechainZkEVMContract.batchFee()).to.be.equal(currentBatchFee);

        /*
         * Now all the batches will be above
         * since the MAX_BATCH_MULTIPLIER is 12 this will be the pow
         */
        await firechainZkEVMContract.updateBatchFee(100);

        currentBatchFee = currentBatchFee.mul(multiplierFee.pow(MAX_BATCH_MULTIPLIER)).div(bingNumber1000.pow(MAX_BATCH_MULTIPLIER));
        expect(currentBatchFee).to.be.equal(await firechainZkEVMContract.batchFee());

        // Check the fee is now below
        await firechainZkEVMContract.setSequencedBatches(50, accInputData, currentTimestamp + verifyBatchTimeTarget * 2, 0); // Below
        currentBatchFee = currentBatchFee.mul(bingNumber1000.pow(MAX_BATCH_MULTIPLIER)).div(multiplierFee.pow(MAX_BATCH_MULTIPLIER));
    });
});

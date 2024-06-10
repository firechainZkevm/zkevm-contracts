/* eslint-disable no-plusplus, no-await-in-loop */
const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

describe('Firechain ZK-EVM TestnetV2', () => {
    let deployer;
    let trustedAggregator;
    let trustedSequencer;
    let admin;

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

    beforeEach('Deploy contract', async () => {
        upgrades.silenceWarnings();

        // load signers
        [deployer, trustedAggregator, trustedSequencer, admin] = await ethers.getSigners();

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
        const FirechainZkEVMFactory = await ethers.getContractFactory('FirechainZkEVMTestnetV2');
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
        expect(await firechainZkEVMContract.version()).to.be.equal(0);
    });

    it('should check updateVersion', async () => {
        const newVersionString = '0.0.2';

        /*
         * const lastVerifiedBatch = 0;
         * await expect(firechainZkEVMContract.updateVersion(newVersionString))
         *     .to.emit(firechainZkEVMContract, 'UpdateZkEVMVersion').withArgs(lastVerifiedBatch, forkID, newVersionString);
         */

        await expect(firechainZkEVMContract.updateVersion(newVersionString))
            .to.be.revertedWith('VersionAlreadyUpdated');

        // expect(await firechainZkEVMContract.version()).to.be.equal(1);
    });
});

const { expect } = require('chai');
const { ethers } = require('hardhat');

const zero32bytes = '0x0000000000000000000000000000000000000000000000000000000000000000';

describe('Global Exit Root L2', () => {
    let FirechainZkEVMBridge;
    let firechainZkEVMGlobalExitRoot;
    let deployer;

    beforeEach('Deploy contracts', async () => {
        // load signers
        [deployer, FirechainZkEVMBridge] = await ethers.getSigners();

        // deploy global exit root manager
        const FirechainZkEVMGlobalExitRootFactory = await ethers.getContractFactory('FirechainZkEVMGlobalExitRootL2Mock', deployer);
        firechainZkEVMGlobalExitRoot = await FirechainZkEVMGlobalExitRootFactory.deploy(FirechainZkEVMBridge.address);
    });

    it('should check the constructor parameters', async () => {
        expect(await firechainZkEVMGlobalExitRoot.bridgeAddress()).to.be.equal(FirechainZkEVMBridge.address);
        expect(await firechainZkEVMGlobalExitRoot.lastRollupExitRoot()).to.be.equal(zero32bytes);
    });

    it('should update root and check global exit root', async () => {
        const newRootRollup = ethers.hexlify(ethers.randomBytes(32));

        await expect(firechainZkEVMGlobalExitRoot.updateExitRoot(newRootRollup))
            .to.be.revertedWith('OnlyAllowedContracts');

        // Update root from the rollup
        await firechainZkEVMGlobalExitRoot.connect(FirechainZkEVMBridge).updateExitRoot(newRootRollup);

        expect(await firechainZkEVMGlobalExitRoot.lastRollupExitRoot()).to.be.equal(newRootRollup);
    });

    it('should update root and check the storage position matches', async () => {
        // Check global exit root
        const newRoot = ethers.hexlify(ethers.randomBytes(32));
        const blockNumber = 1;
        await firechainZkEVMGlobalExitRoot.setLastGlobalExitRoot(newRoot, blockNumber);
        expect(await firechainZkEVMGlobalExitRoot.globalExitRootMap(newRoot)).to.be.equal(blockNumber);
        const mapStoragePosition = 0;
        const key = newRoot;
        const storagePosition = ethers.solidityPackedKeccak256(['uint256', 'uint256'], [key, mapStoragePosition]);
        const storageValue = await ethers.provider.getStorageAt(firechainZkEVMGlobalExitRoot.address, storagePosition);
        expect(blockNumber).to.be.equal(ethers.BigNumber.from(storageValue).toNumber());

        // Check rollup exit root
        const newRootRollupExitRoot = ethers.hexlify(ethers.randomBytes(32));
        await firechainZkEVMGlobalExitRoot.setExitRoot(newRootRollupExitRoot);
        expect(await firechainZkEVMGlobalExitRoot.lastRollupExitRoot()).to.be.equal(newRootRollupExitRoot);

        const storagePositionExitRoot = 1;
        const storageValueExitRoot = await ethers.provider.getStorageAt(firechainZkEVMGlobalExitRoot.address, storagePositionExitRoot);
        expect(newRootRollupExitRoot, storageValueExitRoot);
    });
});

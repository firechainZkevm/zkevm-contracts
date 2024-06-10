const { expect } = require('chai');
const { ethers } = require('hardhat');

function calculateGlobalExitRoot(mainnetExitRoot, rollupExitRoot) {
    return ethers.solidityPackedKeccak256(['bytes32', 'bytes32'], [mainnetExitRoot, rollupExitRoot]);
}
const zero32bytes = '0x0000000000000000000000000000000000000000000000000000000000000000';

describe('Global Exit Root', () => {
    let rollup;
    let FirechainZkEVMBridge;

    let firechainZkEVMGlobalExitRoot;
    beforeEach('Deploy contracts', async () => {
        // load signers
        [, rollup, FirechainZkEVMBridge] = await ethers.getSigners();

        // deploy global exit root manager
        const FirechainZkEVMGlobalExitRootFactory = await ethers.getContractFactory('FirechainZkEVMGlobalExitRoot');

        firechainZkEVMGlobalExitRoot = await FirechainZkEVMGlobalExitRootFactory.deploy(
            rollup.address,
            FirechainZkEVMBridge.address,
        );
        await firechainZkEVMGlobalExitRoot.deployed();
    });

    it('should check the constructor parameters', async () => {
        expect(await firechainZkEVMGlobalExitRoot.rollupAddress()).to.be.equal(rollup.address);
        expect(await firechainZkEVMGlobalExitRoot.bridgeAddress()).to.be.equal(FirechainZkEVMBridge.address);
        expect(await firechainZkEVMGlobalExitRoot.lastRollupExitRoot()).to.be.equal(zero32bytes);
        expect(await firechainZkEVMGlobalExitRoot.lastMainnetExitRoot()).to.be.equal(zero32bytes);
    });

    it('should update root and check global exit root', async () => {
        const newRootRollup = ethers.hexlify(ethers.randomBytes(32));

        await expect(firechainZkEVMGlobalExitRoot.updateExitRoot(newRootRollup))
            .to.be.revertedWith('OnlyAllowedContracts');

        // Update root from the rollup
        await expect(firechainZkEVMGlobalExitRoot.connect(rollup).updateExitRoot(newRootRollup))
            .to.emit(firechainZkEVMGlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(zero32bytes, newRootRollup);

        expect(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot())
            .to.be.equal(calculateGlobalExitRoot(zero32bytes, newRootRollup));

        // Update root from the FirechainZkEVMBridge
        const newRootBridge = ethers.hexlify(ethers.randomBytes(32));
        await expect(firechainZkEVMGlobalExitRoot.connect(FirechainZkEVMBridge).updateExitRoot(newRootBridge))
            .to.emit(firechainZkEVMGlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(newRootBridge, newRootRollup);

        expect(await firechainZkEVMGlobalExitRoot.lastMainnetExitRoot()).to.be.equal(newRootBridge);
        expect(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot())
            .to.be.equal(calculateGlobalExitRoot(newRootBridge, newRootRollup));
    });
});
